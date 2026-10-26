import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EmbeddedPostgresRecoveryIncomplete,
  countRecoveryProgressLines,
  embeddedPostgresServerLogPath,
  isPostmasterPidAlive,
  resolveRecoveryWaitPolicy,
  startEmbeddedPostgresFollowingRecovery,
  type RecoveryWaitPolicy,
} from "../embedded-postgres-start-wait.js";

const LOG_PATH = "C:\\PaperclipData\\db\\server.log";
const PG_CTL_TIMEOUT = new Error(
  "pg_ctl start exited with code 1. waiting for server to start.... stopped waiting\npg_ctl: server did not start in time",
);
const POLICY: RecoveryWaitPolicy = { maxWaitMs: 1_800_000, stallMs: 300_000, pollMs: 1000 };
const RECOVERY_HEAD = [
  "LOG:  database system was interrupted; last known up at 2026-10-26 02:10:00 IST",
  "LOG:  database system was not properly shut down; automatic recovery in progress",
];
const fsyncLine = (seconds: number) =>
  `LOG:  syncing data directory (fsync), elapsed time: ${seconds}.01 s, current path: ./base/16384/2619`;

/**
 * Stands in for the patched embedded-postgres instance on Windows: start() runs a fake pg_ctl
 * that waits up to 60 s and then fails, and stop() keeps the vendor guard (no `process`, no stop).
 * Every stop that would reach `pg_ctl stop -m fast` is recorded.
 */
class FakeEmbeddedPostgres {
  process: unknown = undefined;
  readonly pgCtlStops: string[] = [];
  constructor(private readonly runPgCtlStart: () => Promise<void>) {}
  async start(): Promise<void> {
    this.process = { pid: 4242, kind: "pg_ctl" };
    await this.runPgCtlStart();
  }
  async stop(): Promise<void> {
    if (!this.process) return;
    this.pgCtlStops.push("pg_ctl stop -m fast -w");
  }
}

type Scenario = {
  /** Seconds after start at which the server accepts connections; null = never. */
  readyAt: number | null;
  /** Seconds at which the postmaster dies; null = never. */
  diesAt?: number | null;
  /** Server log lines and the second each one is written. */
  log: Array<[number, string]>;
  /** pg_ctl -t value in seconds. */
  pgCtlTimeout?: number;
};

function simulate(scenario: Scenario, policy = POLICY, waits: Array<{ progressLines: number; waitedMs: number }> = []) {
  let clockMs = 0;
  const seconds = () => clockMs / 1000;
  const pgCtlTimeout = scenario.pgCtlTimeout ?? 60;
  const ready = () => scenario.readyAt !== null && seconds() >= scenario.readyAt;
  const alive = () => scenario.diesAt == null || seconds() < scenario.diesAt;
  const instance = new FakeEmbeddedPostgres(async () => {
    // Fake pg_ctl -w -t <n>: returns as soon as the server is ready, else fails after n seconds.
    const readyAfter = scenario.readyAt ?? Number.POSITIVE_INFINITY;
    if (readyAfter <= pgCtlTimeout) {
      clockMs = readyAfter * 1000;
      return;
    }
    clockMs = pgCtlTimeout * 1000;
    throw PG_CTL_TIMEOUT;
  });
  const exitHookRuns: number[] = [];
  const run = () =>
    startEmbeddedPostgresFollowingRecovery({
      instance,
      serverLogPath: LOG_PATH,
      policy,
      readServerLog: async () =>
        scenario.log.filter(([at]) => at <= seconds()).map(([, line]) => line).join("\n") || null,
      isPostmasterAlive: async () => alive(),
      isReady: async () => {
        // The dependency's process-exit hook may fire at any point while start-up waits.
        exitHookRuns.push(seconds());
        await instance.stop();
        return ready();
      },
      onRecoveryWait: (info) => waits.push(info),
      now: () => clockMs,
      sleep: async (ms) => {
        clockMs += ms;
      },
    });
  return { instance, run, exitHookRuns, seconds };
}

function steadyFsyncLog(untilSeconds: number): Array<[number, string]> {
  const lines: Array<[number, string]> = RECOVERY_HEAD.map((line) => [0, line]);
  for (let at = 10; at <= untilSeconds; at += 10) lines.push([at, fsyncLine(at)]);
  return lines;
}

describe("startEmbeddedPostgresFollowingRecovery", () => {
  it("(a) returns at once on a clean start and keeps stop() armed", async () => {
    const sim = simulate({ readyAt: 2, log: [] });
    await expect(sim.run()).resolves.toEqual({ followedRecovery: false, waitedMs: 2000 });
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toHaveLength(1);
  });

  it("(b) keeps waiting through crash recovery that outlasts the 60 s pg_ctl wait", async () => {
    const log = [...steadyFsyncLog(80), [85, "LOG:  redo starts at 1/48D4A000"], [86, "LOG:  redo done at 1/48D4E1A8"],
      [87, "LOG:  checkpoint starting: end-of-recovery immediate wait"]] as Array<[number, string]>;
    const waits: Array<{ progressLines: number; waitedMs: number }> = [];
    const sim = simulate({ readyAt: 95, log }, POLICY, waits);
    const result = await sim.run();
    expect(result.followedRecovery).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(95_000);
    expect(result.waitedMs).toBeLessThan(97_000);
    // One report when the wait begins (60 s, 8 lines so far), then one per new progress line.
    expect(waits.map((wait) => wait.progressLines)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(waits[0].waitedMs).toBe(60_000);
    // Ready: stop() is armed again so Paperclip's ordered shutdown can stop the server.
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toEqual(["pg_ctl stop -m fast -w"]);
  });

  it("(c) gives up with a clear error when recovery stops making progress", async () => {
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(40) });
    const error = await sim.run().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(EmbeddedPostgresRecoveryIncomplete);
    const incomplete = error as EmbeddedPostgresRecoveryIncomplete;
    expect(incomplete.reason).toBe("stalled");
    expect(incomplete.leftRunning).toBe(true);
    expect(incomplete.startError).toBe(PG_CTL_TIMEOUT);
    expect(incomplete.message).toContain(`Read the server log at ${LOG_PATH}`);
    expect(incomplete.message).toContain("Paperclip did not stop PostgreSQL");
    expect(sim.seconds()).toBeGreaterThanOrEqual(60 + 300);
    expect(sim.seconds()).toBeLessThan(60 + 300 + 5);
  });

  it("(c) gives up at the hard upper bound even while the log still moves", async () => {
    const policy = { ...POLICY, maxWaitMs: 600_000 };
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(3600) }, policy);
    const error = (await sim.run().catch((err: unknown) => err)) as EmbeddedPostgresRecoveryIncomplete;
    expect(error).toBeInstanceOf(EmbeddedPostgresRecoveryIncomplete);
    expect(error.reason).toBe("upper-bound");
    expect(error.message).toContain("the upper bound of 600 s was reached");
    expect(error.message).toContain(LOG_PATH);
    expect(sim.seconds()).toBeGreaterThanOrEqual(600);
    expect(sim.seconds()).toBeLessThan(605);
  });

  it("(d) issues no stop while recovery runs or after giving up", async () => {
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(40) });
    await expect(sim.run()).rejects.toBeInstanceOf(EmbeddedPostgresRecoveryIncomplete);
    expect(sim.exitHookRuns.length).toBeGreaterThan(100);
    // A process-exit hook after the give-up must not stop the recovering server either.
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toEqual([]);
  });

  it("reports an exit during recovery and does not claim the server is still running", async () => {
    const sim = simulate({ readyAt: null, diesAt: 70, log: steadyFsyncLog(65) });
    const error = (await sim.run().catch((err: unknown) => err)) as EmbeddedPostgresRecoveryIncomplete;
    expect(error).toBeInstanceOf(EmbeddedPostgresRecoveryIncomplete);
    expect(error.reason).toBe("exited");
    expect(error.leftRunning).toBe(false);
    expect(error.message).toContain(`Read the server log at ${LOG_PATH}`);
  });

  it("rethrows a start failure without recovery unchanged and leaves stop() armed", async () => {
    const sim = simulate({ readyAt: null, diesAt: 1, log: [[0, "FATAL:  could not create lock file"]] });
    await expect(sim.run()).rejects.toBe(PG_CTL_TIMEOUT);
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toHaveLength(1);
  });

  it("rethrows when the log shows recovery but no postmaster is alive", async () => {
    const sim = simulate({ readyAt: null, diesAt: 0, log: steadyFsyncLog(30) });
    await expect(sim.run()).rejects.toBe(PG_CTL_TIMEOUT);
  });
});

describe("countRecoveryProgressLines", () => {
  it("counts recovery lines and ignores connection refusals from readiness probes", () => {
    const log = [
      ...RECOVERY_HEAD,
      fsyncLine(10),
      "FATAL:  the database system is not yet accepting connections",
      "DETAIL:  Consistent recovery state has not been yet reached.",
      "LOG:  redo in progress, elapsed time: 10.00 s, current LSN: 1/48D4C000",
      "LOG:  database system is ready to accept connections",
    ].join("\r\n");
    expect(countRecoveryProgressLines(log)).toBe(4);
    expect(countRecoveryProgressLines(null)).toBe(0);
  });
});

describe("resolveRecoveryWaitPolicy", () => {
  it("defaults to 1800 s upper bound and 300 s stall window", () => {
    expect(resolveRecoveryWaitPolicy({})).toEqual({ maxWaitMs: 1_800_000, stallMs: 300_000, pollMs: 1000 });
  });

  it("accepts in-range overrides and ignores invalid ones", () => {
    expect(resolveRecoveryWaitPolicy({
      PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_MAX_WAIT_SEC: "900",
      PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_STALL_SEC: "120",
    })).toMatchObject({ maxWaitMs: 900_000, stallMs: 120_000 });
    for (const bad of ["0", "59", "86401", "1.5", "abc", "-5"]) {
      expect(resolveRecoveryWaitPolicy({ PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_MAX_WAIT_SEC: bad }).maxWaitMs)
        .toBe(1_800_000);
    }
    expect(resolveRecoveryWaitPolicy({ PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_STALL_SEC: "29" }).stallMs).toBe(300_000);
  });
});

describe("isPostmasterPidAlive", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const pidFile = (contents: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "pg-start-wait-"));
    dirs.push(dir);
    const file = join(dir, "postmaster.pid");
    if (contents !== null) writeFileSync(file, contents);
    return file;
  };
  const esrch = () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };

  it("is false without a pid file or with a malformed pid", async () => {
    expect(await isPostmasterPidAlive(pidFile(null))).toBe(false);
    expect(await isPostmasterPidAlive(pidFile("not-a-pid\n"))).toBe(false);
  });

  it("follows the process probe", async () => {
    const file = pidFile("4321\r\nC:/data\r\n");
    expect(await isPostmasterPidAlive(file, () => undefined)).toBe(true);
    expect(await isPostmasterPidAlive(file, esrch)).toBe(false);
    expect(await isPostmasterPidAlive(file, () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    })).toBe(true);
  });
});

describe("embeddedPostgresServerLogPath", () => {
  it("uses the instance logFile option when set, else server.log in the data directory", () => {
    const dataDir = resolve(tmpdir(), "pc-db");
    expect(embeddedPostgresServerLogPath({}, dataDir)).toBe(join(dataDir, "server.log"));
    expect(embeddedPostgresServerLogPath({ options: { logFile: "" } }, dataDir)).toBe(join(dataDir, "server.log"));
    const custom = resolve(tmpdir(), "logs", "postgres.log");
    expect(embeddedPostgresServerLogPath({ options: { logFile: custom } }, dataDir)).toBe(custom);
  });
});
