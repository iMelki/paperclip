import { describe, expect, it } from "vitest";
import {
  createNamedSweepScheduler,
  createSweepRunner,
  isTransientConnectTimeout,
  runHeartbeatTickWithConnectRetry,
  schedulerSweepConcurrency,
} from "../services/heartbeat-scheduler-sweeps.ts";
import { withReleasedTransaction } from "../services/short-transaction.ts";

// Models postgres.js: concurrent checkouts open backends until `max`, then
// wait. A wait longer than connect_timeout is the driver's
// `write CONNECT_TIMEOUT <host>:<port>` error. A held checkout is a
// transaction that has not committed.
function connectTimeoutError(): Error {
  const error = new Error("write CONNECT_TIMEOUT 127.0.0.1:54329");
  (error as { code: string }).code = "CONNECT_TIMEOUT";
  return error;
}

function createPool(max: number, connectTimeoutMs: number) {
  let inUse = 0;
  const waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  function releaseSlot(): void {
    inUse -= 1;
    const next = waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);
    inUse += 1;
    next.grant();
  }

  return {
    inUse: () => inUse,
    checkout(): Promise<() => void> {
      const grantRelease = () => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseSlot();
        };
      };
      if (inUse < max) {
        inUse += 1;
        return Promise.resolve(grantRelease());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          grant: () => resolve(grantRelease()),
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(connectTimeoutError());
          }, connectTimeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function holdConnection(pool: ReturnType<typeof createPool>, ms: number): Promise<void> {
  const release = await pool.checkout();
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    release();
  }
}

describe("heartbeat scheduler pool connect timeout", () => {
  it("keeps a probe off CONNECT_TIMEOUT when sweeps overlap a held lock", async () => {
    const poolMax = 3;
    const connectTimeoutMs = 80;
    const lockHoldMs = 400;
    const pool = createPool(poolMax, connectTimeoutMs);
    const runner = createSweepRunner(schedulerSweepConcurrency(poolMax));

    // One sweep holds its connection (the row lock). The other sweeps are the
    // same shape: each needs a connection for the whole hold. The probe is the
    // request path, outside the sweep runner.
    const sweeps = Array.from({ length: poolMax + 3 }, () => () => holdConnection(pool, lockHoldMs));
    const started = Promise.allSettled(sweeps.map((sweep) => runner.run(sweep)));
    const probe = pool.checkout();

    const probeResult = await probe.then(
      (release) => {
        release();
        return "probed" as const;
      },
      (error: unknown) => error,
    );
    expect(probeResult).toBe("probed");
    expect(isTransientConnectTimeout(probeResult)).toBe(false);

    const settled = await started;
    const timedOut = settled.filter(
      (entry) => entry.status === "rejected" && isTransientConnectTimeout(entry.reason),
    );
    expect(timedOut).toHaveLength(0);
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(pool.inUse()).toBe(0);
  });

  it("releases a sweep slot when the sweep throws", async () => {
    const runner = createSweepRunner(1);
    const first = runner.run(async () => {
      throw new Error("sweep failed");
    });
    let secondRan = false;
    const second = runner.run(async () => {
      secondRan = true;
    });
    await expect(first).rejects.toThrow("sweep failed");
    await second;
    expect(secondRan).toBe(true);
    expect(runner.active).toBe(0);
  });

  it("does not stack a second copy of a sweep that still holds its slot", async () => {
    const scheduler = createNamedSweepScheduler(2);
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await hold;
      running -= 1;
    };
    const first = scheduler.start("heartbeat-recovery", task);
    const second = scheduler.start("heartbeat-recovery", task);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(scheduler.inFlightCount).toBe(1);
    releaseHold();
    await first;
    expect(maxRunning).toBe(1);
    expect(scheduler.inFlightCount).toBe(0);
  });

  it("retries CONNECT_TIMEOUT on the heartbeat tick only, with a bounded backoff", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const value = await runHeartbeatTickWithConnectRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        const wrapped = new Error(
          'Failed query: select "id" from "agents": write CONNECT_TIMEOUT 127.0.0.1:54329',
        );
        (wrapped as { cause?: unknown }).cause = connectTimeoutError();
        throw wrapped;
      }
      return "ticked";
    }, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(value).toBe("ticked");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([200, 400]);

    let otherAttempts = 0;
    await expect(runHeartbeatTickWithConnectRetry(async () => {
      otherAttempts += 1;
      throw new Error("statement timeout");
    }, { sleep: async () => { throw new Error("should not back off"); } })).rejects.toThrow("statement timeout");
    expect(otherAttempts).toBe(1);

    let stormAttempts = 0;
    await expect(runHeartbeatTickWithConnectRetry(async () => {
      stormAttempts += 1;
      throw connectTimeoutError();
    }, { sleep: async () => {} })).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(stormAttempts).toBe(3);
  });

  it("records a failure only after the transaction releases its connection", async () => {
    const pool = createPool(1, 50);
    let recorded = false;
    await expect(withReleasedTransaction(
      async (work) => {
        const release = await pool.checkout();
        try {
          return await work(release);
        } finally {
          release();
        }
      },
      async () => {
        throw connectTimeoutError();
      },
      async () => {
        const release = await pool.checkout();
        release();
        recorded = true;
      },
    )).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(recorded).toBe(true);
    expect(pool.inUse()).toBe(0);
  });
});
