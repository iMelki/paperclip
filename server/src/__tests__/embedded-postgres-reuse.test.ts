import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A directory that looks like a PostgreSQL cluster (it has PG_VERSION). */
function clusterDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "PG_VERSION"), "16\n");
  return dir;
}

import {
  EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE,
  acquireEmbeddedStartLock,
  EmbeddedPostgresLockRefusal,
  commandReferencesPath,
  listPostgresProcessesForDataDir,
  moveStaleLockAside,
  readLockIdentity,
  scanPsOutputForDataDir,
  joinPsColumns,
  scanWindowsPostgresRows,
  readRunningEmbeddedPostgres as readRunningReal,
  type PostgresProcess,
} from "../embedded-postgres-reuse.js";

const { probe, warn } = vi.hoisted(() => ({ probe: vi.fn(), warn: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ getPostgresDataDirectory: probe }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

// A lock is moved aside only while the start lock is held, so tests act as a caller that holds it.
const readRunning: typeof readRunningReal = (dataDir, port, adminUrlFor, options = {}) =>
  readRunningReal(dataDir, port, adminUrlFor, { startLockHeld: true, ...options });

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
    writeFileSync(join(dataDir, "PG_VERSION"), "16\n");
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

    it("refuses and keeps an unreadable lock that cannot be taken hold of", async () => {
      mkdirSync(pidFile); // exists but is not a file: it cannot be verified or linked
      probe.mockRejectedValue(new Error("connection refused"));
      const error = await readRunningEmbeddedPostgres(dataDir, 55432).catch((e) => e);
      expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
      expect(existsSync(pidFile)).toBe(true);
      expect(asideFiles()).toHaveLength(0);
    });

      it("keeps the archive out of a cluster directory that was never initialised", async () => {
      rmSync(join(dataDir, "PG_VERSION"));
      garbled();
      probe.mockRejectedValue(new Error("connection refused"));
      expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
      expect(readdirSync(dataDir)).toEqual([]);
      const beside = readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.postmaster.pid.stale-`));
      expect(beside).toHaveLength(1);
      rmSync(join(dirname(dataDir), beside[0]));
    });

    it("ignores a server on the configured port that serves another data directory", async () => {
      garbled();
      probe.mockResolvedValue(clusterDir("other-pg-"));
      expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
      expect(existsSync(pidFile)).toBe(false);
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

    describe("when ownership cannot be proven", () => {
      const withPlatform = async (platform: string, run: () => Promise<void>) => {
        const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
        Object.defineProperty(process, "platform", { value: platform });
        try {
          await run();
        } finally {
          Object.defineProperty(process, "platform", original);
        }
      };
      const unrelatedRows = () => [
        { ProcessId: 5150, CommandLine: '"C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe"' },
        { ProcessId: 5151, CommandLine: `postgres.exe -D ${clusterDir("Other-PG-")}` },
      ];
      const scanRows = (rows: ReturnType<typeof unrelatedRows>) => (dir: string, undecided?: PostgresProcess[]) =>
        scanWindowsPostgresRows(rows, [dir], dir, undecided);

      it("names every blocking process and its command line, and the safe manual step, on win32", async () => {
        await withPlatform("win32", async () => {
          garbled();
          probe.mockRejectedValue(new Error("connection refused"));
          const before = readFileSync(pidFile, "utf8");
          const rows = unrelatedRows();
          const error = await readRunning(dataDir, 55432, adminUrl, {
            readProcessName: async () => null,
            listPostgresProcesses: scanRows(rows),
          }).catch((e) => e);
          expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
          expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
          expect(error.message).toContain("could not be proven");
          for (const row of rows) {
            expect(error.message).toContain(`process ${row.ProcessId}`);
            expect(error.message).toContain(row.CommandLine);
          }
          expect(error.message).toContain("those servers");
          expect(error.message).toContain(`move ${pidFile} aside by hand after confirming no Paperclip instance is running`);
          expect(error.message).toContain("Do not delete any data");
          expect(error.message).not.toMatch(/\b(rm|del|delete the)\b/i);
          expect(readFileSync(pidFile, "utf8")).toBe(before);
          expect(asideFiles()).toHaveLength(0);
        });
      });

      it("names the one blocking process with its stop command on Unix", async () => {
        garbled();
        probe.mockRejectedValue(new Error("connection refused"));
        const out = "901\tpostgres\t/usr/bin/postgres -D /elsewhere -c config_file=/etc/pg.conf\n";
        const error = await readRunning(dataDir, 55432, adminUrl, {
          readProcessName: async () => null,
          listPostgresProcesses: (dir, undecided) =>
            scanPsOutputForDataDir(out, [dir], dir, () => { throw new Error("EACCES"); }, undecided),
        }).catch((e) => e);
        expect(error.message).toContain("could not be proven for PostgreSQL process 901 (/usr/bin/postgres -D /elsewhere");
        expect(error.message).toContain("that server");
        expect(error.message).toMatch(/`(kill|taskkill \/PID) 901`/);
        expect(error.message).toContain(`move ${pidFile} aside by hand`);
      });

      it("never scans processes, and starts normally, on win32 when there is no lock", async () => {
        await withPlatform("win32", async () => {
          rmSync(pidFile, { force: true });
          const listPostgresProcesses = vi.fn(scanRows(unrelatedRows()));
          expect(await readRunning(dataDir, 55432, adminUrl, { listPostgresProcesses })).toBeNull();
          expect(listPostgresProcesses).not.toHaveBeenCalled();
          expect(probe).not.toHaveBeenCalled();
        });
      });

      it("never scans processes, and starts normally, on win32 for a dead-PID lock", async () => {
        await withPlatform("win32", async () => {
          writePid("424242");
          vi.mocked(process.kill).mockImplementation(() => {
            throw Object.assign(new Error("no such process"), { code: "ESRCH" });
          });
          const listPostgresProcesses = vi.fn(scanRows(unrelatedRows()));
          expect(await readRunning(dataDir, 55432, adminUrl, { listPostgresProcesses })).toBeNull();
          expect(listPostgresProcesses).not.toHaveBeenCalled();
        });
      });

      it("never scans processes on win32 when the identity probe proves the owner", async () => {
        await withPlatform("win32", async () => {
          writePid(String(process.pid));
          probe.mockResolvedValue(dataDir);
          const listPostgresProcesses = vi.fn(scanRows(unrelatedRows()));
          expect(await readRunning(dataDir, 55432, adminUrl, { listPostgresProcesses })).toEqual({ pid: process.pid, port: 55432 });
          expect(listPostgresProcesses).not.toHaveBeenCalled();
        });
      });
    });

    describe("a PostgreSQL whose -D names another cluster", () => {
      const other = () => clusterDir("other-pg-");
      const unreadableCwd = () => {
        throw new Error("EACCES");
      };

      it("refuses and preserves the lock when its working directory cannot be read", async () => {
        // An include, include_dir or `-c config_file=` can set the real data directory to this one.
        garbled();
        probe.mockRejectedValue(new Error("connection refused"));
        const before = readFileSync(pidFile, "utf8");
        const out = `901\tpostgres\t/usr/bin/postgres -D ${other()} -c config_file=/etc/external/pg.conf\n`;
        const owners = await scanPsOutputForDataDir(out, [dataDir], dataDir, unreadableCwd);
        expect(owners).toBeNull();
        const error = await readRunningEmbeddedPostgres(dataDir, 55432, null, owners).catch((e) => e);
        expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
        expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
        expect(readFileSync(pidFile, "utf8")).toBe(before);
        expect(asideFiles()).toHaveLength(0);
        expect(readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.postmaster.pid`))).toEqual([]);
      });

      it("refuses and names the process when its working directory is this data directory", async () => {
        garbled();
        probe.mockRejectedValue(new Error("connection refused"));
        const before = readFileSync(pidFile, "utf8");
        const out = `901\tpostgres\t/usr/bin/postgres -D ${other()} -c config_file=/etc/external/pg.conf\n`;
        const owners = await scanPsOutputForDataDir(out, [dataDir], dataDir, () => dataDir);
        expect(owners?.map((owner) => owner.pid)).toEqual([901]);
        const error = await readRunningEmbeddedPostgres(dataDir, 55432, null, owners).catch((e) => e);
        expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
        expect(error.message).toContain("process 901");
        expect(readFileSync(pidFile, "utf8")).toBe(before);
        expect(asideFiles()).toHaveLength(0);
      });
    });
  });

  it.skipIf(process.platform === "win32")("finds a real process named postgres that references the data directory", async () => {
    // The executable path contains a space. `comm` is still `postgres`; identifying
    // the process from the first space-separated token of `args` would skip it.
    const sleepBin = existsSync("/bin/sleep") ? "/bin/sleep" : "/usr/bin/sleep";
    const binDir = join(mkdtempSync(join(tmpdir(), "pg-bin-")), "My Postgres", "bin");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "postgres");
    symlinkSync(sleepBin, bin);
    const child = spawn(bin, ["30"], { cwd: dataDir, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const owners = await listPostgresProcessesForDataDir(dataDir);
      expect(owners?.some((owner) => owner.pid === child.pid && owner.command.includes("My Postgres"))).toBe(true);
      expect((await listPostgresProcessesForDataDir(clusterDir("other-pg-")))?.length ?? 0).toBe(0);
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

  it("moves a dead-PID lock out of an uninitialised cluster directory before initdb runs", async () => {
    rmSync(join(dataDir, "PG_VERSION"));
    writePid("4242");
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(readdirSync(dataDir)).toEqual([]);
    const beside = readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.postmaster.pid.stale-`));
    expect(beside).toHaveLength(1);
    rmSync(join(dirname(dataDir), beside[0]));
  });

  it("moves a recycled-PID lock aside when the configured port serves another data directory", async () => {
    writePid(String(FOREIGN_PID));
    probe.mockImplementation(async (url: string) => {
      if (url.includes("55432")) throw new Error("connection refused");
      return clusterDir("other-pg-");
    });
    expect(await readRunningEmbeddedPostgres(dataDir, 55433, "node")).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
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

  it("names a stop command only for a PID verified as PostgreSQL for this data directory", async () => {
    writePid(String(FOREIGN_PID));
    probe.mockRejectedValue(new Error("the database system is starting up"));
    const owners = [{ pid: FOREIGN_PID, command: `postgres -D ${dataDir}` }];
    const error = await readRunningEmbeddedPostgres(dataDir, 55432, "postgres", owners).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.message).toContain(`postgres -D ${dataDir}`);
    expect(error.message).toMatch(new RegExp(`\`(kill|taskkill /PID) ${FOREIGN_PID}\``));
  });

  it("does not tell the operator to kill a PID that was never tied to this data directory", async () => {
    for (const [name, owners] of [["postgres", []], [null, []], ["postgres", null]] as const) {
      writePid(String(FOREIGN_PID));
      probe.mockRejectedValue(new Error("connection refused"));
      const error = await readRunningEmbeddedPostgres(dataDir, 55432, name, owners ? [...owners] : null).catch((e) => e);
      expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(error.message).not.toMatch(/\`(kill|taskkill \/PID) \d+\`/);
      expect(error.message).toContain("was not confirmed to be PostgreSQL for this data directory");
      expect(error.message).toMatch(/\`(ps -p|tasklist)/);
    }
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

describe("a lock replaced after it was examined", () => {
  let dataDir: string;
  let pidFile: string;
  const stale = (dir: string) => `424242\n${dir}\n1700000000\n55432\n`;
  const live = (dir: string) => `434343\n${dir}\n1700000001\n55432\nstarted-later\n`;
  const names = () => readdirSync(dataDir).filter((name) => name.startsWith("postmaster.pid."));
  const contentsOf = (list: string[]) => list.map((name) => readFileSync(join(dataDir, name), "utf8"));
  const replaceLock = () => {
    rmSync(pidFile);
    writeFileSync(pidFile, live(dataDir));
  };
  const thirdFile = () => {
    rmSync(pidFile, { force: true });
    writeFileSync(pidFile, "third-file\n");
  };
  // Nothing but the examined stale lock may ever be archived: a live lock is never archived.
  const expectOnlyStaleArchived = (examined: string = stale(dataDir)) => {
    for (const text of contentsOf(names().filter((name) => name.includes(".stale-") && !name.endsWith(".moving")))) {
      expect(text).toBe(examined);
    }
  };

  beforeEach(() => {
    vi.resetAllMocks();
    dataDir = clusterDir("replaced-lock-");
    pidFile = join(dataDir, "postmaster.pid");
    writeFileSync(pidFile, stale(dataDir));
    probe.mockRejectedValue(new Error("connection refused"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("moves the examined lock aside when nothing changed", () => {
    const aside = moveStaleLockAside(pidFile, readLockIdentity(pidFile));
    expect(existsSync(pidFile)).toBe(false);
    expect(aside && readFileSync(aside, "utf8")).toBe(stale(dataDir));
    expect(names()).toEqual([basename(aside as string)]);
  });

  it("fails closed when the identity of the examined lock is unknown", () => {
    for (const unknown of [null, undefined]) {
      const error = (() => {
        try {
          moveStaleLockAside(pidFile, unknown);
        } catch (e) {
          return e as EmbeddedPostgresLockRefusal;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(error?.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
      expect(readFileSync(pidFile, "utf8")).toBe(stale(dataDir));
      expect(names()).toEqual([]);
    }
  });

  it("returns null when the lock is already gone", () => {
    const examined = readLockIdentity(pidFile);
    rmSync(pidFile);
    expect(moveStaleLockAside(pidFile, examined)).toBeNull();
  });

  it("never takes a replacement out of its path when it differs before the move", () => {
    const examined = readLockIdentity(pidFile);
    replaceLock();
    const inode = readLockIdentity(pidFile)?.ino;
    expect(() => moveStaleLockAside(pidFile, examined)).toThrow("was replaced while it was being checked");
    // The replacement stayed in place the whole time: same file, no archive, no leftover name.
    expect(readFileSync(pidFile, "utf8")).toBe(live(dataDir));
    expect(readLockIdentity(pidFile)?.ino).toBe(inode);
    expect(names()).toEqual([]);
  });

  it("detects a lock that was rewritten in place", () => {
    const examined = readLockIdentity(pidFile);
    writeFileSync(pidFile, live(dataDir));
    expect(() => moveStaleLockAside(pidFile, examined)).toThrow("was replaced while it was being checked");
    expect(readFileSync(pidFile, "utf8")).toBe(live(dataDir));
    expect(names()).toEqual([]);
  });

  it("puts back a replacement that appears in the instant the lock is moved", () => {
    const examined = readLockIdentity(pidFile);
    expect(() => moveStaleLockAside(pidFile, examined, { afterVerify: replaceLock })).toThrow(
      "was replaced in the instant it was moved. The replacement was put back.",
    );
    expect(readFileSync(pidFile, "utf8")).toBe(live(dataDir));
    expect(names().some((name) => name.endsWith(".moving"))).toBe(false);
    expectOnlyStaleArchived();
  });

  it("keeps a third file that takes the name while a replacement is being put back", () => {
    const examined = readLockIdentity(pidFile);
    let thrown: Error | null = null;
    try {
      moveStaleLockAside(pidFile, examined, { afterVerify: replaceLock, beforeRestore: thirdFile });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(thrown?.message).toContain("the name was taken again before it could be put back");
    // The third file is untouched, and the replacement is preserved, named in the refusal, not archived as stale.
    expect(readFileSync(pidFile, "utf8")).toBe("third-file\n");
    const kept = names().filter((name) => name.endsWith(".moving"));
    expect(kept).toHaveLength(1);
    expect(thrown?.message).toContain(kept[0]);
    expect(readFileSync(join(dataDir, kept[0]), "utf8")).toBe(live(dataDir));
    expectOnlyStaleArchived();
  });

  it("cannot move a lock it cannot take hold of, so a directory in its place is refused", () => {
    rmSync(pidFile);
    mkdirSync(pidFile);
    const examined = readLockIdentity(pidFile);
    expect(() => moveStaleLockAside(pidFile, examined)).toThrow(EmbeddedPostgresLockRefusal);
    expect(existsSync(pidFile)).toBe(true);
    expect(names()).toEqual([]);
  });

  describe.each([
    [
      "a recycled non-PostgreSQL PID",
      () => vi.spyOn(process, "kill").mockReturnValue(true),
      (hooks: { afterVerify?: () => void; beforeRestore?: () => void }) => ({
        readProcessName: async () => "node",
        listPostgresProcesses: async () => [],
        lockMoveHooks: hooks,
      }),
    ],
    [
      "an unreadable-owner lock",
      () => writeFileSync(pidFile, "1oops"),
      (hooks: { afterVerify?: () => void; beforeRestore?: () => void }) => ({
        readProcessName: async () => null,
        listPostgresProcesses: async () => [],
        lockMoveHooks: hooks,
      }),
    ],
  ])("the helper rename for %s", (_name, arrange, optionsFor) => {
    it("keeps a lock that replaces the examined one before the move, with no gap", async () => {
      arrange();
      const examined = readFileSync(pidFile, "utf8");
      const hooks = { afterVerify: replaceLock };
      const result = await readRunning(dataDir, 55432, adminUrl, optionsFor(hooks)).catch((error) => error);
      expect(result).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(result.message).toContain("was replaced in the instant it was moved");
      expect(readFileSync(pidFile, "utf8")).toBe(live(dataDir));
      expect(names().some((name) => name.endsWith(".moving"))).toBe(false);
      expectOnlyStaleArchived(examined);
    });

    it("keeps a third file that takes the name during the restore", async () => {
      arrange();
      const examined = readFileSync(pidFile, "utf8");
      const hooks = { afterVerify: replaceLock, beforeRestore: thirdFile };
      const result = await readRunning(dataDir, 55432, adminUrl, optionsFor(hooks)).catch((error) => error);
      expect(result).toBeInstanceOf(EmbeddedPostgresLockRefusal);
      expect(result.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
      expect(readFileSync(pidFile, "utf8")).toBe("third-file\n");
      const kept = names().filter((name) => name.endsWith(".moving"));
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(dataDir, kept[0]), "utf8")).toBe(live(dataDir));
      expectOnlyStaleArchived(examined);
    });
  });
});

describe("moveStaleLockAside", () => {
  it("renames the lock next to itself and keeps its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
    writeFileSync(join(dir, "PG_VERSION"), "16\n");
    const lock = join(dir, "postmaster.pid");
    writeFileSync(lock, "4242\n");
    const aside = moveStaleLockAside(lock, readLockIdentity(lock));
    expect(existsSync(lock)).toBe(false);
    expect(aside?.startsWith(`${lock}.stale-`)).toBe(true);
    expect(readFileSync(aside as string, "utf8")).toBe("4242\n");
  });

  it("never replaces an earlier archive that has the same timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T22:00:00.000Z"));
    try {
      const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
      writeFileSync(join(dir, "PG_VERSION"), "16\n");
      const lock = join(dir, "postmaster.pid");
      writeFileSync(lock, "first\n");
      const first = moveStaleLockAside(lock, readLockIdentity(lock)) as string;
      writeFileSync(lock, "second\n");
      const second = moveStaleLockAside(lock, readLockIdentity(lock)) as string;
      expect(second).not.toBe(first);
      expect(readFileSync(first, "utf8")).toBe("first\n");
      expect(readFileSync(second, "utf8")).toBe("second\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses with the lock exit code when the lock cannot be moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
    const notADirectory = join(dir, "a-file");
    writeFileSync(notADirectory, "x");
    const unreachable = join(notADirectory, "postmaster.pid"); // ENOTDIR when the lock is looked up
    let thrown: unknown;
    try {
      moveStaleLockAside(unreachable, { dev: 1, ino: 1, size: 1, mtimeMs: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect((thrown as EmbeddedPostgresLockRefusal).exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
  });
});

describe("acquireEmbeddedStartLock", () => {
  let dataDir: string;
  let lockPath: string;
  beforeEach(() => {
    vi.resetAllMocks();
    dataDir = join(mkdtempSync(join(tmpdir(), "start-lock-")), "db");
    mkdirSync(dataDir);
    lockPath = `${dataDir}.paperclip-start.lock`;
  });
  afterEach(() => vi.restoreAllMocks());

  it("is exclusive: a second start waits for the release and then proceeds", async () => {
    const release = await acquireEmbeddedStartLock(dataDir);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(dataDir, `${basename(lockPath)}`))).toBe(false); // outside the data directory
    let second = false;
    const waiting = acquireEmbeddedStartLock(dataDir, { pollMs: 10, timeoutMs: 5000 }).then((r) => {
      second = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second).toBe(false);
    release();
    const releaseSecond = await waiting;
    expect(second).toBe(true);
    releaseSecond();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses after the timeout while a live owner holds it, and keeps the lock", async () => {
    const release = await acquireEmbeddedStartLock(dataDir);
    const held = readFileSync(lockPath, "utf8");
    const error = await acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.message).toContain(lockPath);
    expect(error.message).toContain("Do not delete any data");
    expect(readFileSync(lockPath, "utf8")).toBe(held);
    release();
  });

  it("refuses when the owner cannot be read", async () => {
    writeFileSync(lockPath, "not json");
    const error = await acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 30 }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(readFileSync(lockPath, "utf8")).toBe("not json");
  });

  const deadOwnerKill = () =>
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 424242) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return true;
    });

  it("never moves or removes a lock whose owner is gone: it refuses with a manual step", async () => {
    const dead = JSON.stringify({ pid: 424242, token: "dead" });
    writeFileSync(lockPath, dead);
    const kill = deadOwnerKill();
    const error = await acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 1000 }).catch((e) => e);
    expect(kill).toHaveBeenCalledWith(424242, 0);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
    expect(error.message).toContain(lockPath);
    expect(error.message).toContain("process 424242, which is gone");
    expect(error.message).toContain("by hand");
    expect(error.message).toContain("Do not delete any data");
    expect(readFileSync(lockPath, "utf8")).toBe(dead);
    expect(readdirSync(dirname(dataDir)).filter((name) => name.includes(".stale-") || name.endsWith(".takeover"))).toEqual([]);
  });

  it("two observers of a dead lock and a third starter all leave it untouched", async () => {
    const dead = JSON.stringify({ pid: 424242, token: "dead" });
    writeFileSync(lockPath, dead);
    deadOwnerKill();
    const results = await Promise.all([1, 2, 3].map(() => acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 100 }).catch((e) => e)));
    for (const result of results) expect(result).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(readFileSync(lockPath, "utf8")).toBe(dead);
    expect(readdirSync(dirname(dataDir)).filter((name) => name.includes(".stale-"))).toEqual([]);
  });

  it("an operator who moved the dead lock aside lets exactly one of several waiting starters in at a time", async () => {
    const live = await acquireEmbeddedStartLock(dataDir);
    let holders = 0;
    let maxHolders = 0;
    const order: number[] = [];
    const starters = [1, 2, 3].map((id) =>
      acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 5000 }).then(async (release) => {
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        holders -= 1;
        release();
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual([]);
    live();
    await Promise.all(starters);
    expect(order).toHaveLength(3);
    expect(maxHolders).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is keyed on the physical path, so a symlink to the data directory shares the lock", async () => {
    const alias = join(dirname(dataDir), "alias-of-db");
    symlinkSync(dataDir, alias, "dir");
    const release = await acquireEmbeddedStartLock(dataDir);
    const error = await acquireEmbeddedStartLock(alias, { pollMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.message).toContain(lockPath);
    expect(readdirSync(dirname(dataDir)).filter((name) => name.endsWith(".paperclip-start.lock"))).toEqual([basename(lockPath)]);
    release();
  });

  it("refuses, instead of starting unserialised, when the lock cannot be created", async () => {
    const longName = join(dirname(dataDir), "d".repeat(250));
    const error = await acquireEmbeddedStartLock(longName, { pollMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
    expect(error.message).toContain("could not be created");
  });

  it.each(["EIO", "ENOSPC", "EACCES"])("refuses, removes the empty lock it created and never returns a no-op unlock when writing fails (%s)", async (code) => {
    const error = await acquireEmbeddedStartLock(dataDir, {
      pollMs: 5,
      timeoutMs: 40,
      writeOwner: () => {
        throw Object.assign(new Error("write failed"), { code });
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
    expect(error.message).toContain(code);
    expect(existsSync(lockPath)).toBe(false);
    // A later start is not blocked by a leftover file.
    const release = await acquireEmbeddedStartLock(dataDir);
    release();
  });

  it("refuses when the physical location of the data directory cannot be established", async () => {
    const file = join(dirname(dataDir), "not-a-directory");
    writeFileSync(file, "x");
    const error = await acquireEmbeddedStartLock(join(file, "db"), { pollMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
  });

  it("creates the directory that will contain a data directory on a first start", async () => {
    const fresh = join(dirname(dataDir), "fresh-parent", "db");
    const release = await acquireEmbeddedStartLock(fresh);
    expect(existsSync(`${fresh}.paperclip-start.lock`)).toBe(true);
    release();
    expect(existsSync(`${fresh}.paperclip-start.lock`)).toBe(false);
  });

  it("never takes over a lock whose owner cannot be signalled (EPERM), it waits and then refuses", async () => {
    const held = JSON.stringify({ pid: 424242, token: "other-user" });
    writeFileSync(lockPath, held);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const error = await acquireEmbeddedStartLock(dataDir, { pollMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(kill).toHaveBeenCalledWith(424242, 0);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.message).toContain("process 424242");
    expect(readFileSync(lockPath, "utf8")).toBe(held);
    expect(readdirSync(dirname(dataDir)).filter((name) => name.includes(".stale-"))).toEqual([]);
  });

  it("releases only its own lock", async () => {
    const release = await acquireEmbeddedStartLock(dataDir);
    rmSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    release();
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("commandReferencesPath", () => {
  it("matches only whole data-directory paths", () => {
    const dir = "/srv/paperclip/db";
    expect(commandReferencesPath(`postgres -D ${dir}`, dir)).toBe(true);
    expect(commandReferencesPath(`postgres --data-directory=${dir} -p 5432`, dir)).toBe(true);
    expect(commandReferencesPath(`postgres -D "${dir}"`, dir)).toBe(true);
    expect(commandReferencesPath(`postgres -c config_file=${dir}/postgresql.conf`, dir)).toBe(true);
    expect(commandReferencesPath(`postgres -D ${dir}-backup`, dir)).toBe(false);
    expect(commandReferencesPath(`postgres -D ${dir}2`, dir)).toBe(false);
    expect(commandReferencesPath(`postgres -D /mnt${dir}`, dir)).toBe(false);
  });
});

describe("scanPsOutputForDataDir", () => {
  const dir = "/srv/paperclip/db";
  const unreadable = () => {
    throw new Error("ENOENT");
  };

  it("reports the scan as inconclusive when a PostgreSQL server's directory cannot be read", async () => {
    // Started through PGDATA, on a host without /proc/<pid>/cwd.
    const out = "901\tpostgres\t/usr/lib/postgresql/16/bin/postgres\n902\tsshd\tsshd: me\n";
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
  });

  it("is inconclusive when only the command names another existing data directory", async () => {
    // `data_directory` in a configuration file, or one it includes, can replace `-D`, so another
    // cluster is never proof that this server stores a different one.
    const other = clusterDir("other-pg-");
    const out = `901\tpostgres\t/usr/bin/postgres -D ${other} -c config_file=/etc/pg.conf\n`;
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
  });

  it("treats a readable working directory as authoritative over the command line", async () => {
    const other = clusterDir("other-pg-");
    const out = `901\tpostgres\t/usr/bin/postgres -D ${other}\n`;
    expect(await scanPsOutputForDataDir(out, [dir], dir, () => other)).toEqual([]);
    expect((await scanPsOutputForDataDir(out, [dir], dir, () => dir))?.map((p) => p.pid)).toEqual([901]);
    // The server stores its cluster elsewhere although -D names this one.
    const named = `902\tpostgres\t/usr/bin/postgres -D ${dir}\n`;
    expect(await scanPsOutputForDataDir(named, [dir], dir, () => other)).toEqual([]);
  });

  it("finds the owner when -D is a real cluster, an include hides the data_directory override, and the working directory is the target", async () => {
    const target = clusterDir("pg-target-");
    const configCluster = clusterDir("pg-config-cluster-");
    writeFileSync(join(configCluster, "postgresql.conf"), "include 'hidden.conf'\n");
    writeFileSync(join(configCluster, "hidden.conf"), `data_directory = '${target}'\n`);
    const out = `901\tpostgres\t/usr/bin/postgres -D ${configCluster}\n`;
    expect((await scanPsOutputForDataDir(out, [target], target, () => target))?.map((p) => p.pid)).toEqual([901]);
    // Without a readable working directory the command line cannot rule the server out.
    expect(await scanPsOutputForDataDir(out, [target], target, unreadable)).toBeNull();
  });

  it("recognizes our data directory named through a symlink alias", async () => {
    const real = mkdtempSync(join(tmpdir(), "alias-pg-"));
    const alias = join(mkdtempSync(join(tmpdir(), "alias-link-")), "pgdata");
    symlinkSync(real, alias);
    const out = `901\tpostgres\t/usr/bin/postgres -D ${alias}\n`;
    expect((await scanPsOutputForDataDir(out, [real], real, unreadable))?.map((p) => p.pid)).toEqual([901]);
  });

  it("treats an unresolvable -D value as no evidence", async () => {
    const out = "901\tpostgres\t/usr/bin/postgres -D /does/not/exist/anywhere\n";
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
  });

  it("does not treat a descendant -D directory as the data directory", async () => {
    const base = clusterDir("pg-parent-");
    const child = join(base, "backup");
    mkdirSync(child);
    writeFileSync(join(child, "PG_VERSION"), "16\n");
    const out = `901\tpostgres\t/usr/bin/postgres -D ${child}\n`;
    expect(await scanPsOutputForDataDir(out, [base], base, () => child)).toEqual([]);
    expect(await scanPsOutputForDataDir(out, [base], base, unreadable)).toBeNull();
  });

  it("does not let a configuration-only -D settle ownership (data_directory overrides it)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pg-conf-")); // no PG_VERSION: not a cluster
    const out = `901\tpostgres\t/usr/bin/postgres -D ${configDir}\n`;
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
    expect((await scanPsOutputForDataDir(out, [dir], dir, () => dir))?.map((p) => p.pid)).toEqual([901]);
  });

  it("evaluates the last data-directory option, which PostgreSQL applies", async () => {
    const real = clusterDir("pg-last-");
    const unrelated = clusterDir("pg-first-");
    const out = `901\tpostgres\t/usr/bin/postgres -D ${unrelated} -D ${real}\n`;
    expect((await scanPsOutputForDataDir(out, [real], real, unreadable))?.map((p) => p.pid)).toEqual([901]);
    const reversed = `902\tpostgres\t/usr/bin/postgres -D ${real} -D ${unrelated}\n`;
    expect(await scanPsOutputForDataDir(reversed, [real], real, unreadable)).toBeNull();
  });

  it("does not read the lowercase -d debug level as a data directory", async () => {
    const other = clusterDir("pg-debug-");
    const out = `901\tpostgres\t/usr/bin/postgres -D ${other} -d 5\n`;
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
    const base = clusterDir("pg-debug-parent-");
    const child = join(base, "backup");
    mkdirSync(child);
    writeFileSync(join(child, "PG_VERSION"), "16\n");
    const descendant = `902\tpostgres\t/usr/bin/postgres -D ${child} -d 5\n`;
    expect(await scanPsOutputForDataDir(descendant, [base], base, unreadable)).toBeNull();
  });

  describe("a data_directory setting overrides -D", () => {
    // `-D` may name only the configuration directory of a server that stores this cluster elsewhere.
    const settingForms = (target: string) =>
      [
        ["-c data_directory", `-c data_directory=${target}`],
        ["--data_directory", `--data_directory=${target}`],
      ] as const;

    for (const debugLevel of ["", " -d 5"]) {
      for (const [name] of settingForms("x")) {
        it(`finds the owner when ${name} names the target and -D names another cluster${debugLevel ? " with a trailing -d 5" : ""}`, async () => {
          const target = clusterDir("pg-target-");
          const other = clusterDir("pg-config-dir-");
          const setting = settingForms(target).find(([form]) => form === name)?.[1];
          const out = `901\tpostgres\t/usr/bin/postgres -D ${other} ${setting}${debugLevel}\n`;
          expect((await scanPsOutputForDataDir(out, [target], target, unreadable))?.map((p) => p.pid)).toEqual([901]);
        });
      }
    }

    it("lets the last data_directory setting win", async () => {
      const target = clusterDir("pg-target-");
      const other = clusterDir("pg-other-");
      const toTarget = `901\tpostgres\tpostgres -D ${other} -c data_directory=${other} --data_directory=${target}\n`;
      expect((await scanPsOutputForDataDir(toTarget, [target], target, unreadable))?.map((p) => p.pid)).toEqual([901]);
      // The last setting names another directory: the command cannot show ownership.
      const toOther = `902\tpostgres\tpostgres -D ${target} --data_directory=${target} -c data_directory=${other}\n`;
      expect(await scanPsOutputForDataDir(toOther, [target], target, unreadable)).toBeNull();
      expect(await scanPsOutputForDataDir(toOther, [target], target, () => other)).toEqual([]);
    });

    it("is not ownership when the setting names another directory", async () => {
      const target = clusterDir("pg-target-");
      const other = clusterDir("pg-other-");
      const out = `901\tpostgres\tpostgres -D ${target} -c data_directory=${other}\n`;
      expect(await scanPsOutputForDataDir(out, [target], target, unreadable)).toBeNull();
      expect(await scanPsOutputForDataDir(out, [target], target, () => other)).toEqual([]);
    });

    it("finds the owner through the working directory when only the configuration file sets data_directory", async () => {
      const target = clusterDir("pg-target-");
      const configDir = clusterDir("pg-config-dir-");
      writeFileSync(join(configDir, "postgresql.conf"), `# cluster elsewhere\ndata_directory = '${target}'\n`);
      const out = `901\tpostgres\t/usr/bin/postgres -D ${configDir}\n`;
      expect(await scanPsOutputForDataDir(out, [target], target, unreadable)).toBeNull();
      expect((await scanPsOutputForDataDir(out, [target], target, () => target))?.map((p) => p.pid)).toEqual([901]);
      expect(await scanPsOutputForDataDir(out, [target], target, () => "/elsewhere")).toEqual([]);
    });
  });

  it("finds a server by command line or by working directory", async () => {
    const out = `901\tpostgres\tpostgres -D ${dir}\n902\tpostgres\t/usr/bin/postgres\n903\tpostgres\t/usr/bin/postgres\n`;
    const cwd = (pid: number) => {
      if (pid === 901) throw new Error("ENOENT");
      return pid === 902 ? dir : "/elsewhere";
    };
    expect((await scanPsOutputForDataDir(out, [dir], dir, cwd))?.map((p) => p.pid)).toEqual([901, 902]);
  });

  it("ignores the children of an unrelated PostgreSQL whose directory is known", async () => {
    const other = clusterDir("other-pg-");
    const out =
      `901\tpostgres\t/usr/bin/postgres -D ${other}\n` +
      "902\tpostgres\tpostgres: checkpointer \n903\tpostgres\tpostgres: walwriter\n";
    expect(await scanPsOutputForDataDir(out, [dir], dir, () => other)).toEqual([]);
  });

  it("still examines an executable path that contains spaces", async () => {
    const out = "4401\tpostgres\t/opt/My Postgres/bin/postgres\n";
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toBeNull();
    const cwd = () => dir;
    expect((await scanPsOutputForDataDir(out, [dir], dir, cwd))?.map((p) => p.pid)).toEqual([4401]);
  });
});

describe("scanWindowsPostgresRows", () => {
  const dir = "/srv/paperclip/db";

  it("is inconclusive when postgres.exe does not name a data directory", async () => {
    const rows = [{ ProcessId: 10, CommandLine: "C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe" }];
    expect(await scanWindowsPostgresRows(rows, [dir], dir)).toBeNull();
  });

  it("is inconclusive when WMI omits the command line", async () => {
    expect(await scanWindowsPostgresRows([{ ProcessId: 10, CommandLine: null }], [dir], dir)).toBeNull();
  });

  it("is inconclusive when -D names another existing directory", async () => {
    // A configuration file can replace `-D`, and Windows offers no working directory to check.
    const other = clusterDir("other-pg-");
    const rows = [{ ProcessId: 10, CommandLine: `postgres.exe -D ${other}` }];
    expect(await scanWindowsPostgresRows(rows, [dir], dir)).toBeNull();
  });

  it("reads -D from the original command line, which win32 normalization lowercases", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const other = clusterDir("Other-PG-Mixed-");
      const real = clusterDir("Real-PG-Mixed-");
      expect(await scanWindowsPostgresRows([{ ProcessId: 10, CommandLine: `postgres.exe -D ${other}` }], [dir], dir)).toBeNull();
      // The last -D still wins, and a trailing -d <debug level> does not replace it.
      const last = [{ ProcessId: 11, CommandLine: `postgres.exe -D ${other} -D ${real} -d 5` }];
      expect((await scanWindowsPostgresRows(last, [real], real))?.map((row) => row.pid)).toEqual([11]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("finds the owner when data_directory names the target and -D names another cluster", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const target = clusterDir("Target-PG-Mixed-");
      const other = clusterDir("Config-PG-Mixed-");
      const lines = [
        `postgres.exe -D ${other} -c data_directory=${target}`,
        `postgres.exe -D ${other} -c data_directory=${target} -d 5`,
        `postgres.exe -D ${other} --data_directory=${target} -d 5`,
      ];
      for (const [index, CommandLine] of lines.entries()) {
        const rows = [{ ProcessId: 20 + index, CommandLine }];
        expect((await scanWindowsPostgresRows(rows, [target], target))?.map((row) => row.pid)).toEqual([20 + index]);
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("finds a server whose command line names the data directory", async () => {
    const rows = [{ ProcessId: 10, CommandLine: `postgres.exe -D ${dir}` }];
    expect((await scanWindowsPostgresRows(rows, [dir], dir))?.map((row) => row.pid)).toEqual([10]);
  });

  it("ignores forked children of a postmaster", async () => {
    const rows = [
      { ProcessId: 10, CommandLine: `postgres.exe -D ${dir}` },
      { ProcessId: 11, CommandLine: '"C:\\pg\\bin\\postgres.exe" --forkchild=checkpointer 1234' },
    ];
    expect((await scanWindowsPostgresRows(rows, [dir], dir))?.map((row) => row.pid)).toEqual([10]);
    expect(await scanWindowsPostgresRows(rows.slice(1), [dir], dir)).toEqual([]);
  });

  it("finds nothing when no postgres.exe is running", async () => {
    expect(await scanWindowsPostgresRows([], [dir], dir)).toEqual([]);
  });
});

describe("scanPsOutputForDataDir with a full-path comm column", () => {
  it("reads a macOS comm path that contains spaces from its last segment", async () => {
    const dir = "/srv/paperclip/db";
    const out = `901\t/Applications/Postgres App/bin/postgres\t/Applications/Postgres App/bin/postgres -D ${dir}\n`;
    const unreadable = () => {
      throw new Error("ENOENT");
    };
    expect((await scanPsOutputForDataDir(out, [dir], dir, unreadable))?.map((p) => p.pid)).toEqual([901]);
  });
});

describe("joinPsColumns", () => {
  it("joins separate comm and args listings by pid so spaces in either stay intact", () => {
    const comm = "  901 /Applications/Postgres App/bin/postgres\n  902 sshd: me\n";
    const args = "  901 /Applications/Postgres App/bin/postgres -D /srv/db\n  903 vim notes\n";
    expect(joinPsColumns(comm, args)).toBe(
      "901\t/Applications/Postgres App/bin/postgres\t/Applications/Postgres App/bin/postgres -D /srv/db\n902\tsshd: me\t\n",
    );
  });
});

describe("a stale lock is moved aside only while the start lock is held", () => {
  it("leaves a recycled-PID lock in place and refuses when the caller does not hold the start lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embedded-pg-nostartlock-"));
    writeFileSync(join(dir, "PG_VERSION"), "16\n");
    const lock = join(dir, "postmaster.pid");
    const text = `${process.pid + 1}\n${dir}\n1700000000\n55432\n`;
    writeFileSync(lock, text);
    vi.spyOn(process, "kill").mockReturnValue(true);
    probe.mockReset().mockRejectedValue(new Error("nothing answers"));
    const error = await readRunningReal(dir, 55432, adminUrl, {
      readProcessName: async () => "node",
      listPostgresProcesses: async () => [],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect(error.exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
    expect(error.message).toContain("start lock");
    expect(readFileSync(lock, "utf8")).toBe(text);
    expect(readdirSync(dir).filter((name) => name.includes(".stale-"))).toEqual([]);
    vi.restoreAllMocks();
  });
});
