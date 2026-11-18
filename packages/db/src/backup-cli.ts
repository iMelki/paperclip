import { createWriteStream, type WriteStream } from "node:fs";
import { link, lstat, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BACKUP_CLI_STDERR_BYTES = 64 * 1024;

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

export async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  label: string,
  redact: readonly string[] = [],
): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const detail = redactSecrets(stderr, redact).trim();
  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${detail ? `: ${detail}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Adapted from MIT-licensed upstream PR #13153, head f2fc01afca791781f4b35c8b88d677cee1ecda59.
 * Await both halves before the caller handles failure; this is not a process deadline.
 */
export async function settleBackupChildPipeline(
  pipelinePromise: Promise<unknown>,
  childExitPromise: Promise<unknown>,
): Promise<void> {
  const [pipelineResult, childExitResult] = await Promise.allSettled([pipelinePromise, childExitPromise]);
  if (childExitResult.status === "rejected") throw childExitResult.reason;
  if (pipelineResult.status === "rejected") throw pipelineResult.reason;
}

/**
 * Fixed, secret-free refusal of a connection string that cannot be handed to
 * pg_dump safely. The message never contains any part of the string, so callers
 * may surface it verbatim.
 */
export class PgDumpConnectionStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgDumpConnectionStringError";
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const NOT_A_URL_MESSAGE = "Database connection string must be a postgres:// or postgresql:// URL";

// libpq 16 has PGPASSWORD but no environment variable for the client-key
// passphrase (`sslpassword`), so it can only be given on the command line.
const QUERY_SECRET_KEYS_REFUSED = new Set(["sslpassword"]);

/**
 * Remove secrets from the raw connection string WITHOUT re-serializing it. Going
 * through URL#toString()/URLSearchParams rewrites the query (`%20` -> `+`), and
 * libpq only percent-decodes, so `+` would reach it as a literal plus. Only the
 * userinfo password and `password=` query pairs are cut; every other byte stays.
 */
function stripPasswordsFromRawUrl(raw: string): {
  stripped: string;
  userinfoPassword: string | undefined;
  queryPasswords: string[];
  queryKeys: string[];
} {
  const schemeEnd = raw.indexOf("://") + 3;
  const scheme = raw.slice(0, schemeEnd);
  let rest = raw.slice(schemeEnd);
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash);
    rest = rest.slice(0, hash);
  }
  let query: string | undefined;
  const question = rest.indexOf("?");
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  // Authority ends at the first "/" (the URL parser already stopped it at ?/#).
  const slash = rest.indexOf("/");
  let authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : "";

  let userinfoPassword: string | undefined;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      // An explicit empty password ("user:@host") is still an explicit value.
      userinfoPassword = userinfo.slice(colon + 1);
      const user = userinfo.slice(0, colon);
      authority = (user ? `${user}@` : "") + authority.slice(at + 1);
    }
  }

  const queryPasswords: string[] = [];
  const queryKeys: string[] = [];
  let keptQuery: string | undefined;
  if (query !== undefined) {
    const kept: string[] = [];
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const key = safeDecode(eq >= 0 ? pair.slice(0, eq) : pair);
      queryKeys.push(key);
      if (key === "password") {
        if (eq >= 0) queryPasswords.push(pair.slice(eq + 1));
        continue;
      }
      kept.push(pair);
    }
    keptQuery = kept.join("&");
  }
  const stripped = scheme + authority + path + (keptQuery ? `?${keptQuery}` : "") + fragment;
  return { stripped, userinfoPassword, queryPasswords, queryKeys };
}

/**
 * Build pg_dump argv/env so the database password never appears in argv (visible
 * in process listings). The password is moved to PGPASSWORD in the child's
 * environment only; the connection URL passed to --dbname has it stripped, and
 * every other part of the URL (sslmode, host, percent-encoding, ...) is kept
 * byte-for-byte. A `sslpassword` parameter is refused because libpq has no env
 * var for it. Errors never echo the connection string.
 */
export function buildPgDumpInvocation(
  connectionString: string,
  connectTimeout: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv; secrets: string[] } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PgDumpConnectionStringError(NOT_A_URL_MESSAGE);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PgDumpConnectionStringError(NOT_A_URL_MESSAGE);
  }
  const parts = stripPasswordsFromRawUrl(connectionString);
  if (parts.queryKeys.some((key) => QUERY_SECRET_KEYS_REFUSED.has(key))) {
    throw new PgDumpConnectionStringError(
      "Database connection string sets sslpassword, which cannot be passed to pg_dump safely "
        + "(libpq has no environment variable for it and argv is visible in process listings); "
        + "use an unencrypted client key or remove sslpassword",
    );
  }
  const secrets: string[] = [];
  const env: NodeJS.ProcessEnv = { ...baseEnv, PGCONNECT_TIMEOUT: String(connectTimeout) };
  // libpq applies URI query parameters after userinfo, so the LAST `password=`
  // pair wins over `user:pass@`. libpq percent-decodes only; "+" stays a literal plus.
  const rawEffective = parts.queryPasswords.length > 0 ? parts.queryPasswords.at(-1) : parts.userinfoPassword;
  // Every password seen in the URL is redacted from stderr, winner or not.
  const seen = parts.userinfoPassword === undefined ? parts.queryPasswords : [parts.userinfoPassword, ...parts.queryPasswords];
  for (const raw of seen) secrets.push(safeDecode(raw), raw);
  // An explicit empty password must override an inherited PGPASSWORD; with no
  // password in the URL at all, the inherited value is what libpq would use.
  if (rawEffective !== undefined) env.PGPASSWORD = safeDecode(rawEffective);
  return {
    args: [
      `--dbname=${parts.stripped}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    env,
    secrets,
  };
}

export async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
  output?: WriteStream;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const invocation = buildPgDumpInvocation(opts.connectionString, opts.connectTimeout);
  const child = spawn(pgDumpBin, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: invocation.env,
    windowsHide: true,
  });

  if (!child.stdout) throw new Error("pg_dump did not expose stdout");
  await settleBackupChildPipeline(
    pipeline(child.stdout, createGzip(), opts.output ?? createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin, invocation.secrets),
  );
}

type PreservationPhase = "reserve" | "dump" | "publish";

export class PreservedBackupError extends Error {
  constructor(
    readonly phase: PreservationPhase,
    readonly code: "output_exists" | "output_create_failed" | "dump_failed" | "publish_failed",
    /** Absolute path of the retained staging file (same form as `retainedPartialFile`). */
    readonly retainedArtifact?: string,
    readonly hint?: string,
  ) {
    super(`Preserved database backup failed (${phase}:${code})${hint ? `. ${hint}` : ""}`);
    this.name = "PreservedBackupError";
  }
}

async function refuseExistingOutput(backupFile: string): Promise<void> {
  try {
    await lstat(backupFile);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new PreservedBackupError("reserve", "output_create_failed");
  }
  throw new PreservedBackupError("reserve", "output_exists");
}

/**
 * Only complete, closed gzip output acquires a health-visible .sql.gz name.
 * link() publishes without replacing an existing name. Both names are retained:
 * this is one inode with two directory entries, not an extra recovery copy.
 * No rename, copyFile rollback, pruning or unlink occurs in this policy.
 */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS", "EACCES"]);

// Only fixed, secret-free text is derived from the underlying error (its code).
function failureHint(phase: PreservationPhase, error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  // Fixed, secret-free refusal text from buildPgDumpInvocation (sslpassword, non-URL string).
  if (phase === "dump" && error instanceof PgDumpConnectionStringError) return error.message;
  if (phase === "dump" && code === "ENOENT") {
    return "pg_dump was not found; install the PostgreSQL client tools or set PAPERCLIP_PG_DUMP_PATH, or disable PAPERCLIP_DB_BACKUP_PRESERVE_ALL";
  }
  if (phase === "publish" && NO_HARDLINK_CODES.has(code)) {
    return `could not hard-link the finished dump to its final name (${code}); the backup directory filesystem may not support hard links (FAT/exFAT, some network shares). The complete dump is retained as the staging file; use a hard-link-capable backup directory`;
  }
  return undefined;
}

export async function runPreservedPgDumpBackup(opts: {
  connectionString: string;
  backupDir: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<{ sizeBytes: number; retainedPartialFile: string }> {
  await refuseExistingOutput(opts.backupFile);
  // Refuse an unusable connection string before any staging file exists.
  try {
    buildPgDumpInvocation(opts.connectionString, opts.connectTimeout);
  } catch (error) {
    throw new PreservedBackupError("dump", "dump_failed", undefined, failureHint("dump", error));
  }
  const partialFile = `${opts.backupFile}.partial-${randomUUID()}`;
  let phase: PreservationPhase = "reserve";
  let retainedArtifact: string | undefined;
  let failure: unknown;
  try {
    await mkdir(opts.backupDir, { recursive: true });
    const file = await open(partialFile, "wx", 0o600);
    retainedArtifact = partialFile;
    let output: WriteStream | undefined;
    let sizeBytes: number;
    try {
      output = file.createWriteStream({ autoClose: false, emitClose: false });
      phase = "dump";
      await runPgDumpBackup({ ...opts, output });
      await file.sync();
      sizeBytes = (await file.stat()).size;
    } finally {
      output?.destroy();
      await file.close();
    }
    phase = "publish";
    await link(partialFile, opts.backupFile);
    return { sizeBytes, retainedPartialFile: partialFile };
  } catch (error) {
    failure = error;
    const code = phase === "reserve" ? "output_create_failed"
      : phase === "dump" ? "dump_failed" : "publish_failed";
    // No cause/stderr/connection string is attached to the public error.
    throw new PreservedBackupError(phase, code, retainedArtifact, failureHint(phase, failure));
  }
}
