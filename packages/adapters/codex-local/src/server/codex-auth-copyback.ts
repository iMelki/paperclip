import { execFile as execFileCallback } from "node:child_process";
import { mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  createPrivateStagingDirectory,
  forgetPrivateStagingDirectoryProof,
  hardenNewFileInsidePrivateStagingDirectory,
  prepareCodexCredentialInstallAcl,
  verifyCodexCredentialInstallAcl,
  verifyPrivateStagingDirectory,
} from "./windows-private-acl.js";

const execFile = promisify(execFileCallback);
const MAX_CODEX_AUTH_COPYBACK_BYTES = 1024 * 1024;

// The outbound copy-back reuses the exact same direction-agnostic decision
// predicate the inbound restore runs (`codex-auth-merge-decision.cjs`). The
// predicate answers one question — "should the caller replace `destination`
// with `source`?" — purely by argument order (first = source, second =
// destination). For the copy-back the sandbox credential is the `source` and
// the shared host credential is the `destination`, so exit 10 (use source)
// means "install the sandbox copy onto the host" and exit 20 (keep destination)
// means "leave the host copy untouched". The predicate only ever reads the two
// files and exits with a code; it never prints token bytes.
const DECISION_SCRIPT_PATH = fileURLToPath(
  new URL("./codex-auth-merge-decision.cjs", import.meta.url),
);
const USE_SOURCE_EXIT = 10;
const KEEP_DESTINATION_EXIT = 20;
const TEMP_CLEANUP_ATTEMPTS = 3;
const TEMP_CLEANUP_RETRY_DELAY_MS = 25;

/** Outcome of a copy-back attempt. No token material is ever surfaced. */
export type CopyBackCodexAuthOutcome = "copied" | "kept-host";

export interface CopyBackCodexAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-destroyed)
   * sandbox. In production this is bound to the managed-runtime restore
   * context's `readFile` for `${assetDir}/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * Absolute path of the shared host credential to (maybe) overwrite — the
   * symlink *source* the managed Codex homes point their `auth.json` at, never
   * an in-sandbox or per-agent symlink.
   */
  hostAuthPath: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log: (line: string) => void | Promise<void>;
}

async function decideExitCode(sourcePath: string, destinationPath: string): Promise<number> {
  try {
    await execFile(process.execPath, [DECISION_SCRIPT_PATH, sourcePath, destinationPath]);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === USE_SOURCE_EXIT || code === KEEP_DESTINATION_EXIT) {
      return code;
    }
    // A non-numeric `code` (e.g. "ENOENT" when node is not on PATH) or any exit
    // code other than 10/20 is a hard failure — fail loud so a broken predicate
    // is never mistaken for a "keep host" decision.
    const detail =
      typeof code === "string"
        ? `the current Node runtime could not be executed (${code})`
        : typeof code === "number"
        ? `unexpected predicate exit code ${code}`
        : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`codex auth copy-back decision predicate failed: ${detail}`);
  }

  // Reached only when `execFile` resolved — i.e. the predicate exited 0. The
  // predicate always exits 10 or 20, so a clean exit 0 is unexpected; throw
  // directly here, outside the try/catch, so this already self-explanatory
  // message is not re-wrapped by the catch's "...failed:" prefix.
  throw new Error("codex auth copy-back decision predicate exited 0 (expected 10 or 20)");
}

async function retryCredentialCleanup(label: string, operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < TEMP_CLEANUP_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, TEMP_CLEANUP_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(
    `Codex auth copy-back ${label} cleanup failed after ${TEMP_CLEANUP_ATTEMPTS} attempts.`,
    { cause: lastError },
  );
}

async function removeCredentialStagingTreeWithRetry(
  stagedTempPath: string,
  stagingRoot: string,
): Promise<void> {
  // Remove only the exact expected file, then require the exact directory to be
  // empty. Never recursively delete a staging tree: an unexpected entry is
  // evidence of interference and must remain inspectable behind a loud failure.
  await retryCredentialCleanup("credential temp", () => rm(stagedTempPath, { force: true }));
  await retryCredentialCleanup("empty staging directory", () => rmdir(stagingRoot));
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Codex
 * `auth.json` onto the shared host credential at teardown.
 *
 * Sequence, all under `withDirectoryMergeLock` on the host target's directory
 * so a concurrent inbound restore or another copy-back can't interleave:
 *   1. Read the sandbox credential bytes. A genuinely absent sandbox
 *      `auth.json` (ENOENT) means there is simply nothing to copy back, so it
 *      resolves to `kept-host` (benign no-op, host untouched); every other read
 *      error stays fail-loud.
 *   2. Create an empty temp directory on the **same filesystem** as the host
 *      target, replace its inherited access policy, and only then create the
 *      exclusive predicate-source file inside it. This prevents an inherited
 *      Windows reader from retaining a pre-hardening file handle. Before bytes
 *      are written, POSIX verifies `0600` and Windows installs the exact final
 *      protected credential DACL.
 *   3. Run the Phase-3 decision predicate (`source` = sandbox temp, `destination`
 *      = host). Exit 10 → adopt the sandbox copy; exit 20 → keep the host copy.
 *   4. On exit 10, `rename` the staged temp over the host target — the final
 *      Codex credential policy is verified first, then a same-volume atomic
 *      rename preserves it. On exit 20, discard the temp file.
 * Successful completion proves the staged temp was removed (rename consumes it
 * on the copy path; bounded cleanup retries remove it otherwise). If cleanup
 * cannot be proven, the operation fails loud instead of reporting success.
 * Never logs token bytes — only the decision outcome.
 */
export async function copyBackCodexAuth(input: CopyBackCodexAuthInput): Promise<CopyBackCodexAuthOutcome> {
  const { readSandboxAuth, hostAuthPath, log } = input;

  // Read first (outside the lock) — a read never mutates the host, so there is
  // nothing to serialize yet. A genuinely absent sandbox `auth.json` (ENOENT —
  // e.g. Codex removed it mid-run, or a non-provisioned edge) is a "nothing to
  // copy back" no-op, not a teardown failure: return `kept-host` and log the
  // benign outcome. Every other read error stays fail-loud so a real read fault
  // is never silently mistaken for "nothing to copy back".
  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await log(
        "[paperclip] Codex auth copy-back: no sandbox credential to copy back (absent auth.json); host credential kept.",
      );
      return "kept-host";
    }
    throw error;
  }
  // Bound accepted bytes before creating the host directory, staging, or
  // invoking the predicate. The provider callback still materializes a Buffer;
  // streaming/provider-side enforcement remains a Paperclip #22 follow-up.
  if (sandboxAuthBytes.length > MAX_CODEX_AUTH_COPYBACK_BYTES) {
    throw new Error(
      `Sandbox Codex auth exceeds the ${MAX_CODEX_AUTH_COPYBACK_BYTES}-byte copy-back limit; host credentials were not touched.`,
    );
  }

  const hostDir = path.dirname(hostAuthPath);
  await mkdir(hostDir, { recursive: true });
  return withDirectoryMergeLock(hostDir, async () => {
    // Stage on the same filesystem as the host target so the final rename stays
    // device-local (rename across devices is not atomic and fails with EXDEV).
    // Harden the still-empty directory first: a file created directly under an
    // inherited Windows DACL could be opened by an inherited reader before its
    // DACL is replaced, and changing the DACL would not revoke that open handle.
    const stagingRoot = await createPrivateStagingDirectory(
      hostDir,
      `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp-`,
    );
    const stagedTempPath = path.join(stagingRoot, "auth.json");
    let operationError: unknown;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let handleClosed = false;
    try {
      // `wx` fails if a path somehow appeared despite the empty-directory proof.
      // The new file inherits the already-protected staging-root DACL, closing
      // the Windows pre-hardening handle window. Keep the file owner/SYSTEM/
      // admin-only through both the write and merge decision: a rejected
      // different-identity credential must never become readable by a sandbox
      // peer merely because it was considered for installation.
      handle = await open(stagedTempPath, "wx", 0o600);
      await hardenNewFileInsidePrivateStagingDirectory(stagingRoot, stagedTempPath);
      await handle.writeFile(sandboxAuthBytes);
      await handle.close();
      handleClosed = true;
      await verifyPrivateStagingDirectory(stagingRoot);

      const decision = await decideExitCode(stagedTempPath, hostAuthPath);
      if (decision === USE_SOURCE_EXIT) {
        // Only an accepted same-identity, strictly-newer credential receives
        // the final host readers. The exact DACL replacement is one Windows
        // SetAccessControl operation, is read back against the same file
        // identity, and precedes the device-local atomic rename.
        const aclProof = await prepareCodexCredentialInstallAcl(stagingRoot, stagedTempPath);
        await verifyCodexCredentialInstallAcl(stagedTempPath, aclProof);
        await verifyPrivateStagingDirectory(stagingRoot);
        await rename(stagedTempPath, hostAuthPath);
        await log(
          "[paperclip] Codex auth copy-back: sandbox credential is strictly newer for the same subscription identity; installed atomically after exact host credential access-policy verification.",
        );
        return "copied";
      }

      await log(
        "[paperclip] Codex auth copy-back: host credential kept (sandbox copy is not a strictly-newer same-identity subscription credential).",
      );
      return "kept-host";
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // The temp must never be silently abandoned. On the copy path rename
      // consumed it (force removal is a no-op); every other path retries bounded
      // cleanup and fails loud if credential residue cannot be removed.
      const cleanupErrors: unknown[] = [];
      if (handle && !handleClosed) {
        await handle.close().catch((error) => cleanupErrors.push(error));
      }
      await removeCredentialStagingTreeWithRetry(stagedTempPath, stagingRoot)
        .catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
          "Codex auth copy-back failed to prove credential temp cleanup.",
        );
      }
      forgetPrivateStagingDirectoryProof(stagingRoot);
    }
  });
}
