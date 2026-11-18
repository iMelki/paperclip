import { createWriteStream, type WriteStream } from "node:fs";
import { link, lstat, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BACKUP_CLI_STDERR_BYTES = 64 * 1024;

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

export async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
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

export async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
  output?: WriteStream;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) throw new Error("pg_dump did not expose stdout");
  await settleBackupChildPipeline(
    pipeline(child.stdout, createGzip(), opts.output ?? createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin),
  );
}

type PreservationPhase = "reserve" | "dump" | "publish";

export class PreservedBackupError extends Error {
  constructor(
    readonly phase: PreservationPhase,
    readonly code: "output_exists" | "output_create_failed" | "dump_failed" | "publish_failed",
    readonly retainedArtifact?: string,
  ) {
    super(`Preserved database backup failed (${phase}:${code})`);
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
export async function runPreservedPgDumpBackup(opts: {
  connectionString: string;
  backupDir: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<{ sizeBytes: number; retainedPartialFile: string }> {
  await refuseExistingOutput(opts.backupFile);
  const partialFile = `${opts.backupFile}.partial-${randomUUID()}`;
  let phase: PreservationPhase = "reserve";
  let retainedArtifact: string | undefined;
  try {
    await mkdir(opts.backupDir, { recursive: true });
    const file = await open(partialFile, "wx", 0o600);
    retainedArtifact = basename(partialFile);
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
  } catch {
    const code = phase === "reserve" ? "output_create_failed"
      : phase === "dump" ? "dump_failed" : "publish_failed";
    // No cause/stderr/connection string is attached to the public error.
    throw new PreservedBackupError(phase, code, retainedArtifact);
  }
}
