import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { stopEmbeddedPostgresBounded } from "./test-embedded-postgres.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInstance(stop: () => Promise<void>) {
  return {
    initialise: async () => undefined,
    start: async () => undefined,
    stop,
  };
}

describe("embedded Postgres bounded cleanup custody", () => {
  it("cleans exactly once after an immediate successful stop", async () => {
    const cleanup = vi.fn();

    await stopEmbeddedPostgresBounded(
      createInstance(async () => undefined),
      null,
      cleanup,
      0,
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not clean after an immediate stop rejection", async () => {
    const cleanup = vi.fn();

    await stopEmbeddedPostgresBounded(
      createInstance(async () => {
        throw new Error("stop failed");
      }),
      null,
      cleanup,
      0,
    );

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans once when a timed-out stop later succeeds", async () => {
    const stopped = createDeferred<void>();
    const cleanup = vi.fn();

    await stopEmbeddedPostgresBounded(
      createInstance(() => stopped.promise),
      null,
      cleanup,
      0,
    );
    expect(cleanup).not.toHaveBeenCalled();

    stopped.resolve(undefined);
    await waitForImmediate();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not clean when a timed-out stop later rejects", async () => {
    const stopped = createDeferred<void>();
    const cleanup = vi.fn();

    await stopEmbeddedPostgresBounded(
      createInstance(() => stopped.promise),
      null,
      cleanup,
      0,
    );
    expect(cleanup).not.toHaveBeenCalled();

    stopped.reject(new Error("late stop failure"));
    await waitForImmediate();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
