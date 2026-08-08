import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError as formatEmbeddedPostgresErrorDetails } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { reapWindowsTestProcessTree } from "./test-windows-process-tree.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

type EmbeddedPostgresCtorProvider = () => Promise<EmbeddedPostgresCtor>;

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

let embeddedPostgresCtorProvider: EmbeddedPostgresCtorProvider = loadEmbeddedPostgresCtor;

export function __setEmbeddedPostgresCtorProviderForTests(
  provider: EmbeddedPostgresCtorProvider | null,
): void {
  embeddedPostgresCtorProvider = provider ?? loadEmbeddedPostgresCtor;
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  return await embeddedPostgresCtorProvider();
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  });

  return { dataDir, port, instance, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 20 : 3,
    retryDelay: process.platform === "win32" ? 100 : 10,
  });
}

// Native Windows can take materially longer to initialize a fresh embedded
// cluster when real-time scanning or another serial shard is still releasing
// PostgreSQL children. A timed-out beforeAll cannot retain the cleanup handle,
// so every test that explicitly used the former 20-second setup bound shares
// this platform-aware value.
export const EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS =
  process.platform === "win32" ? 60_000 : 20_000;

// Upper bound (ms) on how long we wait for the embedded Postgres cluster to
// stop gracefully before abandoning the wait and returning from the hook.
const EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 5000;

function readPostmasterPid(dataDir: string): number | null {
  try {
    const firstLine = fs
      .readFileSync(path.join(dataDir, "postmaster.pid"), "utf8")
      .split(/\r?\n/, 1)[0];
    const pid = Number.parseInt(firstLine.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function terminateWindowsPostgresProcessTree(dataDir: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const pid = readPostmasterPid(dataDir);
  const result = await reapWindowsTestProcessTree({
    rootPid: pid ?? 0,
    ownerMarkers: [dataDir],
    timeoutMs: 5_000,
  });
  return result.confirmedStopped;
}

// `embedded-postgres@18.1.0-beta.16` exposes only `stop(): Promise<void>` — no
// shutdown-mode argument. Internally it SIGINTs the postgres process (already
// PostgreSQL "fast shutdown") and resolves *only* on the child's `exit` event,
// with no time bound of its own. Under the loaded serial server shard a slow
// shutdown checkpoint can push that past vitest's hookTimeout and hang the
// afterAll hook. So we bound the graceful stop. On Windows, a timeout or failed
// stop falls back to taskkill for the exact postmaster process tree; other
// platforms keep waiting asynchronously for the graceful stop to settle.
//
// Data-dir reclaim happens only after graceful stop or confirmed forced
// termination. Removing it on the timeout path would pull files out from under
// a still-running cluster and provoke checkpoint / WAL I/O errors.
async function stopEmbeddedPostgresBounded(
  instance: EmbeddedPostgresInstance | null,
  dataDir: string | null,
  cleanupFn?: () => void,
): Promise<void> {
  if (!instance) {
    cleanupFn?.();
    return;
  }
  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cleanupFn?.();
    } catch {
      // Best-effort reclaim; ignore removal errors.
    }
  };
  const stopped = instance.stop().then(
    () => "stopped" as const,
    () => "failed" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: "stopped" | "failed" | "timeout" = "timeout";
  try {
    outcome = await Promise.race([
      stopped,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), EMBEDDED_POSTGRES_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome === "stopped") {
    cleanupOnce();
    return;
  }

  if (process.platform === "win32" && dataDir) {
    const terminated = await terminateWindowsPostgresProcessTree(dataDir);
    if (terminated) {
      cleanupOnce();
      return;
    }
  }

  // Never remove the data directory under a process that may still be alive.
  // The raw stop promise owns cleanup once it eventually settles.
  void stopped.finally(cleanupOnce);
}

const EMBEDDED_POSTGRES_START_MAX_ATTEMPTS = 5;

async function startEmbeddedPostgresWithRetry(tempDirPrefix: string): Promise<{
  port: number;
  dataDir: string;
  instance: EmbeddedPostgresInstance;
  getRecentLogs: () => string[];
}> {
  let lastError = new Error("embedded Postgres startup failed");
  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    try {
      await created.instance.initialise();
      await created.instance.start();
      return created;
    } catch (error) {
      lastError = new Error(formatEmbeddedPostgresError(error, created.getRecentLogs()));
      await stopEmbeddedPostgresBounded(created.instance, created.dataDir, () => {
        cleanupEmbeddedPostgresTestDirs(created.dataDir);
      });
    }
  }
  throw new Error(
    `Failed to start embedded PostgreSQL test database after ${EMBEDDED_POSTGRES_START_MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;

function formatEmbeddedPostgresError(error: unknown, recentLogs: string[] = []): string {
  return formatEmbeddedPostgresErrorDetails(error, {
    fallbackMessage: "embedded Postgres startup failed",
    recentLogs,
  }).message;
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let started: { dataDir: string; instance: EmbeddedPostgresInstance } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await stopEmbeddedPostgresBounded(started?.instance ?? null, started?.dataDir ?? null, () => {
      if (started?.dataDir) cleanupEmbeddedPostgresTestDirs(started.dataDir);
    });
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;

  try {
    const created = await startEmbeddedPostgresWithRetry(tempDirPrefix);
    dataDir = created.dataDir;
    instance = created.instance;
    const { port } = created;

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await stopEmbeddedPostgresBounded(instance, dataDir, () => {
          if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
        });
      },
    };
  } catch (error) {
    await stopEmbeddedPostgresBounded(instance, dataDir, () => {
      if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
    });
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
