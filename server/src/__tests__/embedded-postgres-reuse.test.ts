import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRunningEmbeddedPostgres as readRunning } from "../embedded-postgres-reuse.js";

const { probe, warn } = vi.hoisted(() => ({ probe: vi.fn(), warn: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ getPostgresDataDirectory: probe }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

// The caller owns the embedded login; the helper must not hard-code one.
const adminUrl = (port: number) => `postgres://configured-user:configured-secret@127.0.0.1:${port}/postgres`;
const readRunningEmbeddedPostgres = (dataDir: string, port: number) => readRunning(dataDir, port, adminUrl);
const FOREIGN_PID = 424242;

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
    expect(probe).toHaveBeenCalledWith(adminUrl(55432));
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
    expect(probe).toHaveBeenCalledWith(adminUrl(55433));
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

  it("treats a failed PostgreSQL query for this process's own PID as a stale lock", async () => {
    writePid();
    probe.mockRejectedValue(new Error("connection refused"));
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  const liveness: Array<[string, () => true]> = [
    ["live", () => true],
    ["EPERM", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); }],
    ["EIO", () => { throw Object.assign(new Error("i/o error"), { code: "EIO" }); }],
  ];
  const queryFailures: Array<[string, () => void]> = [
    ["unreachable/null", () => probe.mockResolvedValue(null)],
    ["recovery", () => probe.mockRejectedValue(new Error("the database system is in recovery mode"))],
    ["permission", () => probe.mockRejectedValue(new Error("password authentication failed"))],
  ];
  for (const [livenessName, kill] of liveness) {
    for (const [failureName, failQuery] of queryFailures) {
      it(`refuses and preserves the lock for a foreign ${livenessName} PID when the identity query fails (${failureName})`, async () => {
        writePid(String(FOREIGN_PID));
        vi.mocked(process.kill).mockImplementation(kill);
        failQuery();
        const original = readFileSync(pidFile);
        await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("identity could not be verified");
        expect(probe).toHaveBeenCalledWith(adminUrl(55432));
        expect(readFileSync(pidFile).equals(original)).toBe(true);
      });
    }
  }

  it("reuses PostgreSQL that reports the physical path of a symlinked data directory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "embedded-pg-alias-")));
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    dataDir = alias;
    pidFile = join(alias, "postmaster.pid");
    writePid();
    probe.mockResolvedValue(physical);
    expect(await readRunningEmbeddedPostgres(alias, 55432)).toEqual({ pid: process.pid, port: 55432 });
  });

  describe("data directory case", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

    it("compares data directories case-insensitively on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      writePid();
      probe.mockResolvedValue(dataDir.toUpperCase());
      expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: process.pid, port: 55432 });
    });

    it("keeps case-sensitive comparison off Windows", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      writePid();
      probe.mockResolvedValue(dataDir.toUpperCase());
      await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("data directory belongs to another instance");
    });
  });
});
