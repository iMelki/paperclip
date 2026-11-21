import { beforeEach, describe, expect, it, vi } from "vitest";

const { embeddedPostgresCtorMock, resolveEmbeddedPostgresLockMock, ensurePostgresDatabaseMock } = vi.hoisted(() => ({
  embeddedPostgresCtorMock: vi.fn(),
  resolveEmbeddedPostgresLockMock: vi.fn(),
  ensurePostgresDatabaseMock: vi.fn(),
}));

vi.mock("./runtime-config.js", () => ({
  resolveDatabaseTarget: vi.fn(() => ({
    mode: "embedded-postgres",
    dataDir: "C:/paperclip-synthetic/db",
    port: 54329,
    source: "synthetic",
  })),
}));

vi.mock("./embedded-postgres-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./embedded-postgres-lock.js")>(),
  resolveEmbeddedPostgresLock: resolveEmbeddedPostgresLockMock,
}));

vi.mock("./client.js", () => ({
  ensurePostgresDatabase: ensurePostgresDatabaseMock,
  getPostgresDataDirectory: vi.fn(),
}));

vi.mock("./embedded-postgres-native.js", () => ({
  prepareEmbeddedPostgresNativeRuntime: vi.fn(async () => undefined),
}));

vi.mock("embedded-postgres", () => ({ default: embeddedPostgresCtorMock }));

import { resolveMigrationConnection } from "./migration-runtime.js";

describe("embedded migration startup lock handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEmbeddedPostgresLockMock.mockRejectedValue(
      new Error("Cannot establish whether embedded PostgreSQL pid 123 is running"),
    );
  });

  it("refuses uncertain lock identity before initializing or starting PostgreSQL", async () => {
    await expect(resolveMigrationConnection()).rejects.toThrow(
      "Cannot establish whether embedded PostgreSQL pid 123 is running",
    );

    expect(resolveEmbeddedPostgresLockMock).toHaveBeenCalledTimes(1);
    expect(embeddedPostgresCtorMock).not.toHaveBeenCalled();
    expect(ensurePostgresDatabaseMock).not.toHaveBeenCalled();
  });

  it("leaves a confirmed stale PID file untouched and delegates recovery to PostgreSQL", async () => {
    const instance = {
      initialise: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    embeddedPostgresCtorMock.mockImplementation(function MockEmbeddedPostgres() {
      return instance;
    });
    resolveEmbeddedPostgresLockMock.mockResolvedValue({ state: "stale", pid: 123, port: 54329 });

    const connection = await resolveMigrationConnection();

    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(ensurePostgresDatabaseMock).toHaveBeenCalledTimes(1);
    expect(connection.source).toBe(`embedded-postgres@${embeddedPostgresCtorMock.mock.calls[0]?.[0]?.port}`);
  });
});
