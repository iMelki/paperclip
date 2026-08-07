import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeClaimedDevRunnerShutdown,
  flushDevRunnerPendingExit,
  routeDevRunnerChildExit,
  waitForDevRunnerOutcomeBounded,
  type DevRunnerChildOutcome,
} from "../services/dev-runner-lifecycle.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("dev-runner lifecycle fencing", () => {
  it("queues an unexpected restart-time exit and flushes it exactly once after restart clears", () => {
    const outcome: DevRunnerChildOutcome = { code: 17, signal: null };
    const routed = routeDevRunnerChildExit({
      restartInFlight: true,
      expected: false,
      shuttingDown: false,
      outcome,
    });
    const whileRestarting = flushDevRunnerPendingExit({
      restartInFlight: true,
      shuttingDown: false,
      hasChild: false,
      pending: routed.pending,
    });
    const afterRestart = flushDevRunnerPendingExit({
      restartInFlight: false,
      shuttingDown: false,
      hasChild: false,
      pending: whileRestarting.pending,
    });
    const secondFlush = flushDevRunnerPendingExit({
      restartInFlight: false,
      shuttingDown: false,
      hasChild: false,
      pending: afterRestart.pending,
    });

    expect(routed).toEqual({ action: "deferred", pending: outcome, exitNow: null });
    expect(whileRestarting).toEqual({ pending: outcome, exitNow: null });
    expect(afterRestart).toEqual({ pending: null, exitNow: outcome });
    expect(secondFlush).toEqual({ pending: null, exitNow: null });
  });

  it("retains the claim when the child rejects the shutdown signal", async () => {
    const waitForExit = vi.fn(async () => ({ code: 0, signal: null }));
    const releaseClaim = vi.fn(async () => undefined);

    await expect(completeClaimedDevRunnerShutdown({
      signalChild: () => false,
      signalRejectedError: () => new Error("signal rejected; claim retained"),
      waitForExit,
      releaseClaim,
    })).rejects.toThrow("signal rejected; claim retained");
    expect(waitForExit).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("times out an unobserved child exit without releasing the claim", async () => {
    vi.useFakeTimers();
    const releaseClaim = vi.fn(async () => undefined);
    const pendingExit = new Promise<DevRunnerChildOutcome>(() => undefined);
    const shutdown = completeClaimedDevRunnerShutdown({
      signalChild: () => true,
      signalRejectedError: () => new Error("signal rejected"),
      waitForExit: async () => await waitForDevRunnerOutcomeBounded({
        pending: pendingExit,
        timeoutMs: 1_000,
        timeoutError: () => new Error("child exit timed out; claim retained"),
      }),
      releaseClaim,
    });
    const rejection = expect(shutdown).rejects.toThrow(
      "child exit timed out; claim retained",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(releaseClaim).not.toHaveBeenCalled();
  });
});
