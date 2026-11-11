import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabase: vi.fn(async () => undefined),
  getDataDirectory: vi.fn<() => Promise<string | null>>(),
  resolveLock: vi.fn(async () => ({ state: "missing" as const })),
  construct: vi.fn(),
  dataDir: "C:/Paperclip-Synthetic/DB",
  instance: {
    initialise: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (file: string) => /[/\\]PG_VERSION$/.test(file),
  readFileSync: vi.fn(() => { throw new Error("Unexpected real filesystem read"); }),
}));
vi.mock("node:net", () => ({
  default: { createConnection: vi.fn(() => { throw new Error("Unexpected real connection"); }) },
  createServer: () => {
    let onError: ((error: { code: string }) => void) | undefined;
    const server = {
      unref: () => server,
      once: (_event: string, handler: (error: { code: string }) => void) => { onError = handler; return server; },
      listen: (port: number, _host: string, onListening: () => void) => {
        queueMicrotask(() => port === 54329 ? onError?.({ code: "EADDRINUSE" }) : onListening());
        return server;
      },
      close: () => server,
    };
    return server;
  },
}));
vi.mock("./runtime-config.js", () => ({
  resolveDatabaseTarget: () => ({ mode: "embedded-postgres", dataDir: mocks.dataDir, port: 54329, source: "synthetic" }),
}));
vi.mock("./embedded-postgres-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedded-postgres-lock.js")>(),
  resolveEmbeddedPostgresLock: mocks.resolveLock,
}));
vi.mock("./client.js", () => ({
  ensurePostgresDatabase: mocks.ensureDatabase,
  getPostgresDataDirectory: mocks.getDataDirectory,
}));
vi.mock("./embedded-postgres-native.js", () => ({ prepareEmbeddedPostgresNativeRuntime: vi.fn(async () => undefined) }));
vi.mock("embedded-postgres", () => ({
  default: function MockEmbeddedPostgres(options: unknown) {
    mocks.construct(options);
    return mocks.instance;
  },
}));

import { resolveMigrationConnection } from "./migration-runtime.js";
import { isSameEmbeddedPostgresDataDirectory } from "./embedded-postgres-lock.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(value: "win32" | "linux") {
  Object.defineProperty(process, "platform", { ...originalPlatform, value });
}

describe("migration adoption uses platform-correct data-directory identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dataDir = "C:/Paperclip-Synthetic/DB";
    mocks.resolveLock.mockResolvedValue({ state: "missing" });
  });
  afterEach(() => { Object.defineProperty(process, "platform", originalPlatform); });

  it.each(["c:/paperclip-synthetic/db", "c:\\paperclip-synthetic\\DB", "C:/PAPERCLIP-SYNTHETIC/DB/."])(
    "adopts the verified Windows directory %s without constructing another server",
    async (actualDataDir) => {
      setPlatform("win32");
      mocks.getDataDirectory.mockResolvedValue(actualDataDir);
      const connection = await resolveMigrationConnection();
      expect(connection.source).toBe("embedded-postgres@54329");
      expect(mocks.ensureDatabase).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:54329/postgres", "paperclip");
      expect(mocks.construct).not.toHaveBeenCalled();
      expect(mocks.instance.start).not.toHaveBeenCalled();
      await connection.stop();
      expect(mocks.instance.stop).not.toHaveBeenCalled();
    },
  );

  it("refuses an occupied configured port whose directory cannot be verified", async () => {
    setPlatform("win32");
    mocks.getDataDirectory.mockResolvedValue(null);
    await expect(resolveMigrationConnection()).rejects.toThrow("Cannot verify PostgreSQL identity");
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.ensureDatabase).not.toHaveBeenCalled();
  });

  it("preserves case-sensitive Linux identity and the existing verified-other-directory fallback", async () => {
    setPlatform("linux");
    mocks.dataDir = "/tmp/paperclip-synthetic/DB";
    mocks.getDataDirectory.mockResolvedValue("/tmp/paperclip-synthetic/db");
    expect(isSameEmbeddedPostgresDataDirectory(mocks.dataDir, "/tmp/paperclip-synthetic/db")).toBe(false);
    const connection = await resolveMigrationConnection();
    expect(connection.source).toBe("embedded-postgres@54330");
    expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ databaseDir: mocks.dataDir, port: 54330 }));
    expect(mocks.instance.start).toHaveBeenCalledTimes(1);
    await connection.stop();
    expect(mocks.instance.stop).toHaveBeenCalledTimes(1);
  });
});
