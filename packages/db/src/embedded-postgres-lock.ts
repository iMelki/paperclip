import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export type EmbeddedPostgresLockResult =
  | { state: "missing" }
  | { state: "stale"; pid: number; port: number }
  | { state: "running"; pid: number; port: number };

export type EmbeddedPostgresLockOperations = {
  readFile: (filePath: string) => string;
  probeProcess: (pid: number) => "running" | "stale";
  probePort: (port: number) => Promise<"open" | "closed">;
  getDataDirectory: (port: number) => Promise<string | null>;
};

const defaultOperations: EmbeddedPostgresLockOperations = {
  readFile: (filePath) => readFileSync(filePath, "utf8"),
  probeProcess: (pid) => {
    try {
      process.kill(pid, 0);
      return "running";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stale";
      throw new Error(`Cannot establish whether embedded PostgreSQL pid ${pid} is running`, { cause: error });
    }
  },
  probePort: (port) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve("open");
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Cannot establish whether embedded PostgreSQL port ${port} is available`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve("closed");
      else reject(new Error(`Cannot establish whether embedded PostgreSQL port ${port} is available`, { cause: error }));
    });
  }),
  getDataDirectory: async () => {
    throw new Error("Embedded PostgreSQL data-directory verification was not configured");
  },
};

export function isSameEmbeddedPostgresDataDirectory(left: string, right: string): boolean {
  const windows = process.platform === "win32";
  const resolve = windows ? path.win32.resolve : path.resolve;
  const a = resolve(left);
  const b = resolve(right);
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseLock(raw: string): { pid: number; dataDir: string; port: number } {
  const lines = raw.split(/\r?\n/);
  const pid = Number(lines[0]?.trim());
  const dataDir = lines[1]?.trim();
  const port = Number(lines[3]?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || !dataDir || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Embedded PostgreSQL postmaster.pid is malformed; preserving it and refusing startup");
  }
  return { pid, dataDir, port };
}

/**
 * Inspect an embedded PostgreSQL lock without mutating it. For a positively
 * stale lock, the caller may ask PostgreSQL to start on the same data directory:
 * PostgreSQL's own atomic lock-file protocol rechecks the owner and removes a
 * stale postmaster.pid only when its native safety checks pass. Never unlink
 * postmaster.pid from application code.
 */
export async function resolveEmbeddedPostgresLock(
  lockPath: string,
  expectedDataDir: string,
  operations: Partial<EmbeddedPostgresLockOperations> = {},
): Promise<EmbeddedPostgresLockResult> {
  const ops: EmbeddedPostgresLockOperations = { ...defaultOperations, ...operations };
  let raw: string;
  try {
    raw = ops.readFile(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw new Error("Cannot read embedded PostgreSQL postmaster.pid; preserving state and refusing startup", { cause: error });
  }

  const lock = parseLock(raw);
  if (!isSameEmbeddedPostgresDataDirectory(lock.dataDir, expectedDataDir)) {
    throw new Error("Embedded PostgreSQL postmaster.pid points to a different data directory; preserving it and refusing startup");
  }
  const assertLockUnchanged = () => {
    let currentRaw: string;
    try {
      currentRaw = ops.readFile(lockPath);
    } catch (error) {
      throw new Error("Embedded PostgreSQL lock changed during verification; refusing startup", { cause: error });
    }
    if (currentRaw !== raw) {
      throw new Error("Embedded PostgreSQL lock changed during verification; refusing startup");
    }
  };

  const processState = ops.probeProcess(lock.pid);
  if (processState === "running") {
    const actualDataDir = await ops.getDataDirectory(lock.port);
    if (!actualDataDir || !isSameEmbeddedPostgresDataDirectory(actualDataDir, expectedDataDir)) {
      throw new Error("Embedded PostgreSQL process identity could not be verified; preserving postmaster.pid and refusing startup");
    }
    assertLockUnchanged();
    return { state: "running", pid: lock.pid, port: lock.port };
  }

  const portState = await ops.probePort(lock.port);
  if (portState === "open") {
    const actualDataDir = await ops.getDataDirectory(lock.port);
    if (actualDataDir && isSameEmbeddedPostgresDataDirectory(actualDataDir, expectedDataDir)) {
      assertLockUnchanged();
      return { state: "running", pid: lock.pid, port: lock.port };
    }
    throw new Error("Embedded PostgreSQL lock is stale but its port is occupied by an unverified server; preserving state and refusing startup");
  }

  assertLockUnchanged();
  return { state: "stale", pid: lock.pid, port: lock.port };
}
