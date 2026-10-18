import { describe, expect, it, vi } from "vitest";
import {
  resolveEmbeddedPostgresLock,
  type EmbeddedPostgresLockOperations,
} from "./embedded-postgres-lock.js";

const lock = (pid = 123, dir = "C:/paperclip/db", port = 54329) => `${pid}\n${dir}\n0\n${port}\n`;

function fixture(overrides: Partial<EmbeddedPostgresLockOperations> = {}) {
  const readFile = vi.fn(() => lock());
  const probeProcess = vi.fn(() => "running" as const);
  const probePort = vi.fn(async () => "closed" as const);
  const getDataDirectory = vi.fn(async () => "C:/paperclip/db");
  const operations = { readFile, probeProcess, probePort, getDataDirectory, ...overrides };
  return { operations, readFile, probeProcess, probePort, getDataDirectory };
}

describe("resolveEmbeddedPostgresLock", () => {
  it("allows reuse only after process and data-directory identity are verified", async () => {
    const f = fixture();
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations))
      .resolves.toEqual({ state: "running", pid: 123, port: 54329 });
  });

  it("reports a positively stale lock without deleting it so PostgreSQL can perform native recovery", async () => {
    const f = fixture({
      probeProcess: vi.fn(() => "stale" as const),
      probePort: vi.fn(async () => "closed" as const),
    });
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations))
      .resolves.toEqual({ state: "stale", pid: 123, port: 54329 });
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unreadable lock", { readFile: vi.fn(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) }],
    ["malformed lock", { readFile: vi.fn(() => "not-a-pid\n") }],
    ["unknown process state", { probeProcess: vi.fn(() => { throw new Error("EPERM"); }) }],
    ["unverified live identity", { getDataDirectory: vi.fn(async () => null) }],
    ["occupied unverified stale port", {
      probeProcess: vi.fn(() => "stale" as const),
      probePort: vi.fn(async () => "open" as const),
      getDataDirectory: vi.fn(async () => null),
    }],
    ["different data directory", { readFile: vi.fn(() => lock(123, "C:/other/db")) }],
  ])("preserves the lock and refuses on %s", async (_name, overrides) => {
    const f = fixture(overrides as Partial<EmbeddedPostgresLockOperations>);
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations)).rejects.toThrow();
  });

  it("treats only ENOENT as a missing lock", async () => {
    const f = fixture({ readFile: vi.fn(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }) });
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations)).resolves.toEqual({ state: "missing" });
  });

  it("refuses if a lock changes during stale verification", async () => {
    const f = fixture({
      readFile: vi.fn().mockReturnValueOnce(lock()).mockReturnValueOnce(lock(124)),
      probeProcess: vi.fn(() => "stale" as const),
      probePort: vi.fn(async () => "closed" as const),
    });
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations)).rejects.toThrow("changed");
  });

  it("refuses reuse if the lock changes while database identity is being checked", async () => {
    const f = fixture({
      readFile: vi.fn().mockReturnValueOnce(lock()).mockReturnValueOnce(lock(124)),
    });
    await expect(resolveEmbeddedPostgresLock("postmaster.pid", "C:/paperclip/db", f.operations)).rejects.toThrow("changed");
  });
});
