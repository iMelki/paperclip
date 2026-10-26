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
  serverLogShowsRecoveryInProgress,
  startEmbeddedPostgresFollowingRecovery,
  type RecoveryWaitPolicy,
  type StartFollowingRecoveryInput,
} from "../embedded-postgres-start-wait.js";

const LOG_PATH = "C:\\PaperclipData\\db\\server.log";
const PG_CTL_TIMEOUT = new Error(
  "pg_ctl start exited with code 1. waiting for server to start.... stopped waiting\npg_ctl: server did not start in time",
);
const POLICY: RecoveryWaitPolicy = { maxWaitMs: 1_800_000, stallMs: 300_000, pollMs: 1000, probeTimeoutMs: 10_000 };
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

type Clock = { seconds: () => number; advance: (ms: number) => void };

function simulate(
  scenario: Scenario,
  policy = POLICY,
  waits: Array<{ progressLines: number; waitedMs: number }> = [],
  overrides: (clock: Clock) => Partial<StartFollowingRecoveryInput> = () => ({}),
) {
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
  const clock: Clock = {
    seconds,
    advance: (ms) => {
      clockMs += ms;
    },
  };
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
      ...overrides(clock),
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

describe("review round 1 fixes", () => {
  /** A probe timer on the fake clock: it elapses at once after moving the clock by its duration. */
  const fakeProbeTimer = (clock: Clock) => (ms: number) => {
    clock.advance(ms);
    return { elapsed: Promise.resolve(), cancel: () => {} };
  };

  it("F1: a readiness probe that never settles cannot hold the wait past the upper bound", { timeout: 2000 }, async () => {
    const timeouts: number[] = [];
    const policy = { ...POLICY, maxWaitMs: 600_000 };
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(3600) }, policy, [], (clock) => ({
      isReady: (timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return new Promise<boolean>(() => {}); // connected but stuck: never answers
      },
      probeTimer: fakeProbeTimer(clock),
    }));
    const error = (await sim.run().catch((err: unknown) => err)) as EmbeddedPostgresRecoveryIncomplete;
    expect(error).toBeInstanceOf(EmbeddedPostgresRecoveryIncomplete);
    expect(error.reason).toBe("upper-bound");
    expect(sim.seconds()).toBeGreaterThanOrEqual(600);
    expect(sim.seconds()).toBeLessThanOrEqual(611);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(10_000);
    // A stuck check is awaited again, not repeated: one connection at most.
    expect(timeouts).toHaveLength(1);
  });

  it("F1: a slow readiness check that answers later is still used", { timeout: 2000 }, async () => {
    let calls = 0;
    let answer: (ready: boolean) => void = () => {};
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(3600) }, POLICY, [], (clock) => ({
      isReady: () => {
        calls += 1;
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
      probeTimer: (ms: number) => {
        if (clock.seconds() < 90) return fakeProbeTimer(clock)(ms);
        answer(true); // the pending check answers during the 90 s poll, before its deadline
        return { elapsed: new Promise<void>(() => {}), cancel: () => {} };
      },
    }));
    await expect(sim.run()).resolves.toMatchObject({ followedRecovery: true });
    expect(calls).toBe(1);
  });

  it("F1: a stuck probe cannot pass the stall deadline and is cut to the time left", { timeout: 2000 }, async () => {
    const timeouts: Array<[number, number]> = [];
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(40) }, POLICY, [], (clock) => ({
      isReady: () => new Promise<boolean>(() => {}),
      probeTimer: (ms: number) => {
        timeouts.push([clock.seconds(), ms]); // when the probe starts, and how long it may take
        return fakeProbeTimer(clock)(ms);
      },
    }));
    const error = (await sim.run().catch((err: unknown) => err)) as EmbeddedPostgresRecoveryIncomplete;
    expect(error.reason).toBe("stalled");
    expect(sim.seconds()).toBeGreaterThanOrEqual(360);
    expect(sim.seconds()).toBeLessThanOrEqual(361);
    // Stall deadline at 360 s: a probe never runs past it.
    for (const [at, timeoutMs] of timeouts) expect(at * 1000 + timeoutMs).toBeLessThanOrEqual(360_000);
  });

  for (const phase of ["init", "cleanup"]) {
    it(`F2: "resetting unlogged relations (${phase})" progress lines keep the wait going`, async () => {
      const log: Array<[number, string]> = RECOVERY_HEAD.map((line) => [0, line]);
      for (let at = 10; at <= 400; at += 10) {
        log.push([at, `LOG:  resetting unlogged relations (${phase}), elapsed time: ${at}.00 s, current path: base/${at}`]);
      }
      const sim = simulate({ readyAt: 400, log });
      await expect(sim.run()).resolves.toMatchObject({ followedRecovery: true });
      expect(sim.seconds()).toBe(400);
    });
  }

  it("F2: counts every PostgreSQL 18 startup progress format", () => {
    for (const line of [
      "LOG:  syncing data directory (syncfs), elapsed time: 10.00 s, current path: base",
      "LOG:  syncing data directory (pre-fsync), elapsed time: 10.00 s, current path: ./base/1/2",
      "LOG:  syncing data directory (fsync), elapsed time: 10.00 s, current path: ./base/1/2",
      "LOG:  resetting unlogged relations (init), elapsed time: 10.00 s, current path: base/5",
      "LOG:  resetting unlogged relations (cleanup), elapsed time: 10.00 s, current path: base/5",
      "LOG:  redo in progress, elapsed time: 10.00 s, current LSN: 0/1A2B3C4",
    ]) {
      expect(countRecoveryProgressLines(line), line).toBe(1);
    }
  });

  it("F4: a liveness probe that throws counts as alive and does not replace the start error", async () => {
    const sim = simulate({ readyAt: 95, log: steadyFsyncLog(90) }, POLICY, [], () => ({
      isPostmasterAlive: async () => {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      },
    }));
    await expect(sim.run()).resolves.toMatchObject({ followedRecovery: true });
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toEqual(["pg_ctl stop -m fast -w"]);
  });

  it("F4: a probe that throws synchronously rethrows the original start error with stop() armed", async () => {
    const sim = simulate({ readyAt: null, log: steadyFsyncLog(40) }, POLICY, [], () => ({
      readServerLog: () => {
        throw new Error("probe bug");
      },
    }));
    await expect(sim.run()).rejects.toBe(PG_CTL_TIMEOUT);
    await sim.instance.stop();
    expect(sim.instance.pgCtlStops).toEqual(["pg_ctl stop -m fast -w"]);
  });

  it("F4: a reporting callback that throws does not end the wait", async () => {
    const sim = simulate({ readyAt: 95, log: steadyFsyncLog(90) }, POLICY, [], () => ({
      onRecoveryWait: () => {
        throw new Error("logger down");
      },
    }));
    await expect(sim.run()).resolves.toMatchObject({ followedRecovery: true });
  });

  it("serverLogShowsRecoveryInProgress is false once the ready line appears", () => {
    const recovering = `${RECOVERY_HEAD.join("\n")}\n${fsyncLine(10)}`;
    expect(serverLogShowsRecoveryInProgress(recovering)).toBe(true);
    expect(serverLogShowsRecoveryInProgress(`${recovering}\nLOG:  database system is ready to accept connections`))
      .toBe(false);
    expect(serverLogShowsRecoveryInProgress("LOG:  database system is ready to accept connections")).toBe(false);
    expect(serverLogShowsRecoveryInProgress(null)).toBe(false);
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
    expect(resolveRecoveryWaitPolicy({})).toEqual({
      maxWaitMs: 1_800_000, stallMs: 300_000, pollMs: 1000, probeTimeoutMs: 10_000,
    });
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

  it("F3: presumes alive when the pid file exists but cannot be read (not ENOENT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-start-wait-"));
    dirs.push(dir);
    // Reading a directory fails with EISDIR (or EPERM on some Windows builds), never ENOENT.
    expect(await isPostmasterPidAlive(dir, () => undefined)).toBe(true);
  });

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
