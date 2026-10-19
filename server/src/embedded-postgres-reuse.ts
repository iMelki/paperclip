import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getPostgresDataDirectory } from "@paperclipai/db";
import { logger } from "./middleware/logger.js";

/** Builds the admin connection URL for a port, using the caller's embedded login. */
export type EmbeddedPostgresAdminUrl = (port: number) => string;

async function canonicalDataDirectory(dir: string): Promise<string> {
  const absolute = resolve(dir);
  // Physical canonicalization so symlink/junction aliases compare equal. A path
  // that cannot be resolved (for example, another host's directory) keeps its
  // lexical form and therefore only matches an identical path.
  const physical = await realpath(absolute).catch(() => absolute);
  return process.platform === "win32" ? physical.toLowerCase() : physical;
}

export async function isSameDataDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalDataDirectory(a), canonicalDataDirectory(b)]);
  return left === right;
}

/**
 * Returns the PostgreSQL recorded in `postmaster.pid` when it is verified to
 * serve `dataDir`, or `null` only when the lock is affirmatively stale (no
 * PID file, unparseable PID, a dead PID, or this process's own PID). Throws,
 * leaving the lock untouched, whenever a possibly-live owner cannot be
 * identified, because removing its lock could start a second postmaster.
 */
export async function readRunningEmbeddedPostgres(
  dataDir: string,
  configuredPort: number,
  adminUrl: EmbeddedPostgresAdminUrl,
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
    // Only ESRCH proves the process is gone. EPERM and any other error leave
    // liveness unknown, so identity must still be established.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
  }

  const port = Number(lines[3]?.trim() || configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Refusing to reuse PostgreSQL: postmaster.pid has an invalid port.");
  }
  // PID occupancy alone is not PostgreSQL identity: the OS may recycle it.
  // A query also distinguishes PostgreSQL from an unrelated TCP listener.
  const actualDataDir = await getPostgresDataDirectory(adminUrl(port)).catch(() => null);
  if (actualDataDir === null) {
    if (pid === process.pid) {
      // The lock names this Node process, which is not PostgreSQL.
      logger.warn(
        { pid, port },
        "Embedded PostgreSQL identity could not be verified and postmaster.pid names the current process; treating postmaster.pid as stale and trying normal startup",
      );
      return null;
    }
    throw new Error(
      `Refusing to start embedded PostgreSQL: postmaster.pid names process ${pid}, which may still be alive, ` +
        `but PostgreSQL identity could not be verified on port ${port} (it may be starting, recovering, ` +
        "or refusing the login). The lock file was left unchanged. Stop that process, or remove " +
        "postmaster.pid only after confirming no PostgreSQL uses this data directory.",
    );
  }
  if (!(await isSameDataDirectory(actualDataDir, dataDir))) {
    throw new Error("Refusing to reuse PostgreSQL: its data directory belongs to another instance.");
  }
  return { pid, port };
}
