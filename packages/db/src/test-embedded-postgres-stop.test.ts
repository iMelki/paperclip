import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setEmbeddedPostgresCtorProviderForTests as setCtor,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
  __stopEmbeddedPostgresBoundedForTests as stopBounded,
} from "./test-embedded-postgres.js";

const effects = vi.hoisted(() => ({ remove: vi.fn(), reap: vi.fn() }));
vi.mock("./client.js", () => ({}));
vi.mock("./embedded-postgres-native.js", () => ({}));
vi.mock("./test-windows-process-tree.js", () => ({ reapWindowsTestProcessTree: effects.reap }));
vi.mock("node:fs", () => ({ default: {
  mkdtempSync: () => "C:\\synthetic-test-only\\cluster",
  rmSync: effects.remove,
  readFileSync: () => "12345\n",
} }));
vi.mock("node:net", () => ({ default: {
  createServer: () => ({
    unref() {}, on() {},
    listen(_port: number, _host: string, callback: () => void) { callback(); },
    address: () => ({ port: 45678 }),
    close(callback: () => void) { callback(); },
  }),
} }));

// The forced-cleanup branch under test is guarded by process.platform.
const windowsOnly = process.platform === "win32" ? it : it.skip;

function instance(stop: () => Promise<void>) {
  return { initialise: async () => {}, start: async () => {}, stop };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  setCtor(null);
});

describe("bounded embedded PostgreSQL cleanup", () => {
  it("reclaims once after confirmed graceful stop", async () => {
    const cleanup = vi.fn();
    expect(await stopBounded(instance(async () => {}), null, cleanup)).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves data after rejected or synchronous failed stop: %s", async (sync) => {
    const cleanup = vi.fn();
    const stop = () => { if (sync) throw new Error("stop failed"); return Promise.reject(new Error("stop failed")); };
    expect(await stopBounded(instance(stop), null, cleanup)).toBe(false);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([false, true])("timeout preserves data; late success alone permits cleanup: %s", async (success) => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const result = stopBounded(instance(() => pending), null, cleanup);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    if (success) resolve(); else reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledTimes(success ? 1 : 0);
  });

  // This caller can never hold Job Object custody of a postmaster that
  // embedded-postgres spawned, so confirmedStopped is unreachable for it. The
  // reclaim decision therefore rides on the advisory observation, and both of
  // its outcomes need to be pinned: neither was covered before, which is how
  // the no-custody regression reached review.
  windowsOnly.each([
    { observed: true, reclaims: true, reason: "no_owned_processes" },
    { observed: false, reclaims: false, reason: "advisory_only_without_job_object" },
  ])(
    "reclaims the data dir only when no owned process is still observable: $observed",
    async ({ observed, reclaims, reason }) => {
      const cleanup = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      effects.reap.mockResolvedValue({
        confirmedStopped: false,
        observedNoOwnedProcesses: observed,
        stopEvidence: "advisory",
        reason,
        remainingPids: observed ? [] : [4242],
      });

      const result = await stopBounded(
        instance(() => Promise.reject(new Error("stop failed"))),
        "C:\\synthetic-test-only\\cluster",
        cleanup,
      );

      expect(effects.reap).toHaveBeenCalledTimes(1);
      // By default nothing is forced: force is an explicit, named opt-in.
      // Ownership is always scoped to this cluster's own data directory.
      expect(effects.reap).toHaveBeenCalledWith(expect.objectContaining({
        ownerMarkers: ["C:\\synthetic-test-only\\cluster"],
        forceWithoutCustody: false,
      }));
      expect(result).toBe(reclaims);
      await Promise.resolve();
      expect(cleanup).toHaveBeenCalledTimes(reclaims ? 1 : 0);
      // An unstopped cluster is reported loudly, by name, with PIDs and reason.
      // A reclaimable one is not reported as a problem.
      if (reclaims) {
        expect(warn).not.toHaveBeenCalled();
      } else {
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toContain("NOT stopped");
        expect(message).toContain("C:\\synthetic-test-only\\cluster");
        expect(message).toContain("PIDs=4242");
        expect(message).toContain(`reason=${reason}`);
        expect(message).toContain("force=not requested");
      }
      warn.mockRestore();
    },
  );

  windowsOnly(
    "forces a stop only when the caller asks for it by name, and reports it as forced",
    async () => {
      const cleanup = vi.fn();
      effects.reap.mockResolvedValue({
        confirmedStopped: false,
        observedNoOwnedProcesses: true,
        stopEvidence: "forced",
        reason: "forced_none_observed",
        remainingPids: [],
      });

      const result = await stopBounded(
        instance(() => Promise.reject(new Error("stop failed"))),
        "C:\\synthetic-test-only\\cluster",
        cleanup,
        { forceStopWithoutCustody: true },
      );

      expect(effects.reap).toHaveBeenCalledWith(expect.objectContaining({
        ownerMarkers: ["C:\\synthetic-test-only\\cluster"],
        forceWithoutCustody: true,
      }));
      expect(result).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry or remove data when failed-start cleanup is unresolved", async () => {
    let constructed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A full result, matching ReapWindowsTestProcessTreeResult: a cluster that
    // is still observably running and was not forced.
    effects.reap.mockResolvedValue({
      confirmedStopped: false,
      observedNoOwnedProcesses: false,
      stopEvidence: "advisory",
      reason: "advisory_only_without_job_object",
      remainingPids: [12345],
    });
    class Fake {
      constructor() { constructed += 1; }
      async initialise() {}
      async start() { throw new Error("original startup failure"); }
      async stop() { throw new Error("stop failed"); }
    }
    setCtor(async () => Fake);
    await expect(startWithRetry("synthetic-only-")).rejects.toThrow(
      /cleanup unresolved; no retry; data preserved.*original startup failure/,
    );
    await Promise.resolve();
    expect(constructed).toBe(1);
    expect(effects.remove).not.toHaveBeenCalled();
    if (process.platform === "win32") {
      // The unresolved cluster is named, with its PID, not silently left.
      expect(String(warn.mock.calls[0]?.[0])).toContain("PIDs=12345");
    }
    warn.mockRestore();
  });
});
