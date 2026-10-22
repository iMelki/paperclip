import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE,
  EmbeddedPostgresLockRefusal,
  commandReferencesPath,
  listPostgresProcessesForDataDir,
  moveStaleLockAside,
  scanPsOutputForDataDir,
  joinPsColumns,
  scanWindowsPostgresRows,
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

    it("moves an unreadable lock aside when nothing owns the directory", async () => {
      mkdirSync(pidFile); // exists but cannot be read as a file
      probe.mockRejectedValue(new Error("connection refused"));
      expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
      expect(existsSync(pidFile)).toBe(false);
      expect(asideFiles()).toHaveLength(1);
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
      probe.mockResolvedValue(mkdtempSync(join(tmpdir(), "other-pg-")));
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

describe("moveStaleLockAside", () => {
  it("renames the lock next to itself and keeps its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
    writeFileSync(join(dir, "PG_VERSION"), "16\n");
    const lock = join(dir, "postmaster.pid");
    writeFileSync(lock, "4242\n");
    const aside = moveStaleLockAside(lock);
    expect(existsSync(lock)).toBe(false);
    expect(aside.startsWith(`${lock}.stale-`)).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe("4242\n");
  });

  it("never replaces an earlier archive that has the same timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T22:00:00.000Z"));
    try {
      const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
      writeFileSync(join(dir, "PG_VERSION"), "16\n");
      const lock = join(dir, "postmaster.pid");
      writeFileSync(lock, "first\n");
      const first = moveStaleLockAside(lock);
      writeFileSync(lock, "second\n");
      const second = moveStaleLockAside(lock);
      expect(second).not.toBe(first);
      expect(readFileSync(first, "utf8")).toBe("first\n");
      expect(readFileSync(second, "utf8")).toBe("second\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses with the lock exit code when the lock cannot be moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "embedded-pg-aside-"));
    const missing = join(dir, "no-such-dir", "postmaster.pid");
    let thrown: unknown;
    try {
      moveStaleLockAside(missing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EmbeddedPostgresLockRefusal);
    expect((thrown as EmbeddedPostgresLockRefusal).exitCode).toBe(EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE);
    expect((thrown as Error).message).toContain("could not be moved aside");
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

  it("is conclusive when the command names another existing data directory", async () => {
    const other = mkdtempSync(join(tmpdir(), "other-pg-"));
    const out = `901\tpostgres\t/usr/bin/postgres -D ${other} -c config_file=/etc/pg.conf\n`;
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toEqual([]);
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
    const base = mkdtempSync(join(tmpdir(), "pg-parent-"));
    const child = join(base, "backup");
    mkdirSync(child);
    const out = `901\tpostgres\t/usr/bin/postgres -D ${child}\n`;
    expect(await scanPsOutputForDataDir(out, [base], base, unreadable)).toEqual([]);
  });

  it("finds a server by command line or by working directory", async () => {
    const out = `901\tpostgres\tpostgres -D ${dir}\n902\tpostgres\t/usr/bin/postgres\n903\tpostgres\t/usr/bin/postgres\n`;
    const cwd = (pid: number) => (pid === 902 ? dir : "/elsewhere");
    expect((await scanPsOutputForDataDir(out, [dir], dir, cwd))?.map((p) => p.pid)).toEqual([901, 902]);
  });

  it("ignores the children of an unrelated PostgreSQL whose directory is conclusive", async () => {
    const other = mkdtempSync(join(tmpdir(), "other-pg-"));
    const out =
      `901\tpostgres\t/usr/bin/postgres -D ${other}\n` +
      "902\tpostgres\tpostgres: checkpointer \n903\tpostgres\tpostgres: walwriter\n";
    expect(await scanPsOutputForDataDir(out, [dir], dir, unreadable)).toEqual([]);
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

  it("is conclusive when -D names another existing directory", async () => {
    const other = mkdtempSync(join(tmpdir(), "other-pg-"));
    const rows = [{ ProcessId: 10, CommandLine: `postgres.exe -D ${other}` }];
    expect(await scanWindowsPostgresRows(rows, [dir], dir)).toEqual([]);
  });

  it("finds a server whose command line names the data directory", async () => {
    const rows = [{ ProcessId: 10, CommandLine: `postgres.exe -D ${dir}` }];
    expect((await scanWindowsPostgresRows(rows, [dir], dir))?.map((row) => row.pid)).toEqual([10]);
  });

  it("ignores forked children of an unrelated postmaster", async () => {
    const other = mkdtempSync(join(tmpdir(), "other-pg-"));
    const rows = [
      { ProcessId: 10, CommandLine: `postgres.exe -D ${other}` },
      { ProcessId: 11, CommandLine: '"C:\\pg\\bin\\postgres.exe" --forkchild=checkpointer 1234' },
    ];
    expect(await scanWindowsPostgresRows(rows, [dir], dir)).toEqual([]);
  });

  it("finds nothing when no postgres.exe is running", async () => {
    expect(await scanWindowsPostgresRows([], [dir], dir)).toEqual([]);
  });
});

describe("scanPsOutputForDataDir with a full-path comm column", () => {
  it("reads a macOS comm path that contains spaces from its last segment", async () => {
    const dir = "/srv/paperclip/db";
    const out = `901\t/Applications/Postgres App/bin/postgres\t/Applications/Postgres App/bin/postgres -D ${dir}\n`;
    expect((await scanPsOutputForDataDir(out, [dir], dir, () => "/elsewhere"))?.map((p) => p.pid)).toEqual([901]);
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
