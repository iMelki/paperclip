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

  it("does not retry or remove data when failed-start cleanup is unresolved", async () => {
    let constructed = 0;
    effects.reap.mockResolvedValue({ confirmedStopped: false });
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
  });
});
