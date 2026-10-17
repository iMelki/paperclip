import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPostgresDataDirectory } from "@paperclipai/db";
import { logger } from "./middleware/logger.js";

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
    // Permission denied is not evidence that the process is dead.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
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
    logger.warn(
      { pid, port },
      "Embedded PostgreSQL identity could not be verified; treating postmaster.pid as stale and trying normal startup",
    );
    return null;
  }
  if (resolve(actualDataDir) !== resolve(dataDir)) {
    throw new Error("Refusing to reuse PostgreSQL: its data directory belongs to another instance.");
  }
  return { pid, port };
}
