import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE,
  EmbeddedPostgresLockRefusal,
  listPostgresProcessesForDataDir,
  readRunningEmbeddedPostgres as readRunning,
  type PostgresProcess,
} from "../embedded-postgres-reuse.js";

const { probe, warn } = vi.hoisted(() => ({ probe: vi.fn(), warn: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ getPostgresDataDirectory: probe }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

// The caller owns the embedded login; the helper must not hard-code one.
const adminUrl = (port: number) => `postgres://configured-user:configured-secret@127.0.0.1:${port}/postgres`;
const readRunningEmbeddedPostgres = (
  dataDir: string,
  port: number,
  processName: string | null = null,
  owners: PostgresProcess[] | null = [],
) =>
  readRunning(dataDir, port, adminUrl, {
    readProcessName: async () => processName,
    listPostgresProcesses: async () => owners,
  });
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

  describe("a lock that cannot name its owner", () => {
    const garbled = () => writePid("1oops");
    const asideFiles = () => readdirSync(dataDir).filter((n) => n.startsWith("postmaster.pid.stale-"));

    it.each(["0", "-1", "1oops", "1.5", "9007199254740992", ""])(
      "moves the lock aside for invalid PID %j when no PostgreSQL answers or references the directory",
      async (pid) => {
        writePid(pid);
        probe.mockRejectedValue(new Error("connection refused"));
        const original = readFileSync(pidFile, "utf8");
        expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
        expect(existsSync(pidFile)).toBe(false);
        expect(asideFiles()).toHaveLength(1);
        expect(readFileSync(join(dataDir, asideFiles()[0]), "utf8")).toBe(original);
        expect(process.kill).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ problem: "does not hold a valid process id" }),
          expect.stringContaining("moved the lock file aside"),
        );
      },
    );

    it("moves an unreadable lock aside when nothing owns the directory", async () => {
      mkdirSync(pidFile); // exists but cannot be read as a file
      probe.mockRejectedValue(new Error("connection refused"));
      expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
      expect(existsSync(pidFile)).toBe(false);
      expect(asideFiles()).toHaveLength(1);
    });

    it("refuses and names the process when a PostgreSQL references the data directory", async () => {
      garbled();
      probe.mockRejectedValue(new Error("connection refused"));
      const owners = [{ pid: 4321, command: `postgres -D ${dataDir}` }];
      const error = await readRunningEmbeddedPostgres(dataDir, 55432, null, owners).catch((e) => e);
      expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
      expect(error.message).toContain("process 4321");
      expect(error.message).toContain(`postgres -D ${dataDir}`);
      expect(error.message).toMatch(/`(kill|taskkill \/PID) 4321`/);
      expect(existsSync(pidFile)).toBe(true);
      expect(asideFiles()).toHaveLength(0);
    });

    it("refuses when a PostgreSQL answers on the configured port", async () => {
      garbled();
      probe.mockResolvedValue(dataDir);
      await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("answering on port 55432");
      expect(existsSync(pidFile)).toBe(true);
    });

    it("refuses when the process list cannot be read", async () => {
      garbled();
      probe.mockRejectedValue(new Error("connection refused"));
      const error = await readRunningEmbeddedPostgres(dataDir, 55432, null, null).catch((e) => e);
      expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(error.message).toContain("process list could not be read");
      expect(existsSync(pidFile)).toBe(true);
    });
  });

  it.skipIf(process.platform === "win32")("finds a real process named postgres that references the data directory", async () => {
    // argv[0] is what `ps` reports as the command, as for a real postmaster.
    const child = spawn("sleep", ["30"], { argv0: `postgres -D ${dataDir}`, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const owners = await listPostgresProcessesForDataDir(dataDir);
      expect(owners?.some((o) => o.pid === child.pid && o.command.includes(dataDir))).toBe(true);
      expect((await listPostgresProcessesForDataDir(mkdtempSync(join(tmpdir(), "other-pg-"))))?.length ?? 0).toBe(0);
    } finally {
      child.kill();
    }
  });

  it("lists no PostgreSQL processes for an unused data directory", async () => {
    const owners = await listPostgresProcessesForDataDir(dataDir);
    // null only when `ps` is unavailable; never a false positive.
    expect(owners === null || owners.length === 0).toBe(true);
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

  it("moves a leftover lock aside when its live PID is not PostgreSQL and no server answers", async () => {
    writePid(String(FOREIGN_PID));
    probe.mockRejectedValue(new Error("connection refused"));
    const original = readFileSync(pidFile, "utf8");
    expect(await readRunningEmbeddedPostgres(dataDir, 55432, "node")).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
    const aside = readdirSync(dataDir).find((name) => name.startsWith("postmaster.pid.stale-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dataDir, aside!), "utf8")).toBe(original);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps refusing when the live PID is PostgreSQL, whatever its extension", async () => {
    for (const name of ["postgres", "postmaster", "postgres.exe"]) {
      writePid(String(FOREIGN_PID));
      probe.mockRejectedValue(new Error("the database system is starting up"));
      await expect(readRunningEmbeddedPostgres(dataDir, 55432, name)).rejects.toThrow("identity could not be verified");
      expect(existsSync(pidFile)).toBe(true);
    }
  });

  it("keeps refusing when the process name cannot be determined", async () => {
    writePid(String(FOREIGN_PID));
    probe.mockRejectedValue(new Error("connection refused"));
    await expect(readRunningEmbeddedPostgres(dataDir, 55432, null)).rejects.toThrow("identity could not be verified");
    expect(existsSync(pidFile)).toBe(true);
  });

  it("keeps refusing when PostgreSQL answers on the configured port instead of the recorded one", async () => {
    writePid(String(FOREIGN_PID), "55433");
    probe.mockImplementation(async (url: string) => {
      if (url === adminUrl(55432)) return dataDir;
      throw new Error("connection refused");
    });
    await expect(readRunningEmbeddedPostgres(dataDir, 55432, "node")).rejects.toThrow("identity could not be verified");
    expect(existsSync(pidFile)).toBe(true);
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

    // The faked platform cannot change the real filesystem: on Windows the real
    // realpath folds case, so this behavior is only observable elsewhere.
    it.skipIf(process.platform === "win32")("keeps case-sensitive comparison off Windows", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      writePid();
      probe.mockResolvedValue(dataDir.toUpperCase());
      await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("data directory belongs to another instance");
    });
  });
});
