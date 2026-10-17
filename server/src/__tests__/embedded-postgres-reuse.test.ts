import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRunningEmbeddedPostgres } from "../embedded-postgres-reuse.js";

const { probe, warn } = vi.hoisted(() => ({ probe: vi.fn(), warn: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ getPostgresDataDirectory: probe }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

describe("embedded PostgreSQL reuse identity", () => {
  let dataDir: string;
  let pidFile: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), "embedded-pg-identity-"));
    pidFile = join(dataDir, "postmaster.pid");
    probe.mockResolvedValue(dataDir);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  function writePid(pid: string = String(process.pid), port = "55432") {
    writeFileSync(pidFile, `${pid}\n${dataDir}\n1700000000\n${port}\n\nlocalhost\n\nready\n`);
  }

  it("does not reuse a recycled PID owned by node when PostgreSQL is unreachable", async () => {
    writePid();
    probe.mockResolvedValue(null); // The PostgreSQL port is closed, but the PID is alive.
    const original = readFileSync(pidFile, "utf8");

    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(process.kill).toHaveBeenCalledWith(process.pid, 0);
    expect(probe).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:55432/postgres");
    expect(warn).toHaveBeenCalledWith(
      { pid: process.pid, port: 55432 },
      expect.stringContaining("treating postmaster.pid as stale"),
    );
    expect(readFileSync(pidFile, "utf8")).toBe(original);
  });

  it("reuses a live PostgreSQL server with the matching data directory", async () => {
    writePid();
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: process.pid, port: 55432 });
    expect(probe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("probes and reuses the recorded port when the configured port differs", async () => {
    writePid(String(process.pid), "55433\r");
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: process.pid, port: 55433 });
    expect(probe).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:55433/postgres");
  });

  it("does not reuse a dead PID", async () => {
    writePid();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("checks PostgreSQL identity when PID liveness is inaccessible", async () => {
    writePid();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: process.pid, port: 55432 });
  });

  it("does not reuse a missing PID file", async () => {
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1oops", "1.5", "9007199254740992"])("does not reuse invalid PID %s", async (pid) => {
    writePid(pid);
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(process.kill).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses another PostgreSQL data directory and preserves the lock", async () => {
    writePid();
    probe.mockResolvedValue(resolve(dataDir, "another-instance"));
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("data directory belongs to another instance");
    expect(existsSync(pidFile)).toBe(true);
  });

  it.each(["0", "65536", "55432oops"])("refuses invalid recorded port %s without discarding the lock", async (port) => {
    writePid(String(process.pid), port);
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("invalid port");
    expect(existsSync(pidFile)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats a failed PostgreSQL query as unverified identity", async () => {
    writePid();
    probe.mockRejectedValue(new Error("connection refused"));
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
