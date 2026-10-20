import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getPostgresDataDirectory } from "@paperclipai/db";
import { logger } from "./middleware/logger.js";

export class EmbeddedPostgresDirectoryIdentityError extends Error {
  constructor(reason: "mismatch" | "unknown", cause?: unknown) {
    super(
      reason === "mismatch"
        ? "Refusing to reuse PostgreSQL: its data directory belongs to another instance."
        : "Refusing embedded PostgreSQL startup: data directory identity could not be verified.",
      { cause },
    );
    this.name = "EmbeddedPostgresDirectoryIdentityError";
  }
}

// Canonical-path check under the existing stable-namespace startup contract.
// This does not hold directory handles or prove identity across concurrent replacement.
export function assertMatchingEmbeddedPostgresDirectory(expectedDir: string, reportedDir: string): void {
  try {
    const expected = realpathSync.native(expectedDir, { encoding: "buffer" });
    const reported = realpathSync.native(reportedDir, { encoding: "buffer" });
    if (!statSync(expected).isDirectory() || !statSync(reported).isDirectory()) {
      throw new EmbeddedPostgresDirectoryIdentityError("unknown");
    }
    // Do not case-fold: Windows directories can also be case-sensitive.
    if (!expected.equals(reported)) {
      throw new EmbeddedPostgresDirectoryIdentityError("mismatch");
    }
    // Refuse observable retargeting; repeated resolution is not an atomic object check.
    if (
      !realpathSync.native(expectedDir, { encoding: "buffer" }).equals(expected)
      || !realpathSync.native(reportedDir, { encoding: "buffer" }).equals(reported)
    ) {
      throw new EmbeddedPostgresDirectoryIdentityError("unknown");
    }
  } catch (error) {
    if (error instanceof EmbeddedPostgresDirectoryIdentityError) throw error;
    throw new EmbeddedPostgresDirectoryIdentityError("unknown", error);
  }
}

export async function readRunningEmbeddedPostgres(
  dataDir: string,
  configuredPort: number,
): Promise<{ pid: number; port: number } | null> {
  const pidFile = resolve(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  let lines: string[];
  try {
    lines = readFileSync(pidFile, "utf8").split("\n");
  } catch {
    return null;
  }
  const pid = Number(lines[0]?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only an explicit missing-process result proves that the PID is stale.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
  }

  const port = Number(lines[3]?.trim() || configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Refusing to reuse PostgreSQL: postmaster.pid has an invalid port.");
  }
  // PID occupancy alone is not PostgreSQL identity: the OS may recycle it.
  // A query also distinguishes PostgreSQL from an unrelated TCP listener.
  const actualDataDir = await getPostgresDataDirectory(
    `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`,
  ).catch(() => null);
  if (actualDataDir === null) {
    // This process is the Node server, so its own PID is affirmative stale-PID evidence.
    // A foreign live/inaccessible PID can still be PostgreSQL during recovery.
    const recycledSelfPid = pid === process.pid;
    logger.warn(
      { pid, port },
      recycledSelfPid
        ? "The current Node process owns this PID; treating postmaster.pid as stale and trying normal startup"
        : "Embedded PostgreSQL identity could not be verified; preserving postmaster.pid and refusing startup",
    );
    if (!recycledSelfPid) {
      throw new Error("Refusing embedded PostgreSQL startup: identity could not be verified for a live process.");
    }
    return null;
  }
  assertMatchingEmbeddedPostgresDirectory(dataDir, actualDataDir);
  return { pid, port };
}
