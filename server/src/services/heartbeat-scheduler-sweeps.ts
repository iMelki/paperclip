import { effectiveDatabasePoolMax } from "@paperclipai/db/client";

/**
 * postgres.js (`max`, default 10) opens a new backend for every concurrent
 * query until the pool is full, and only then queues. A heartbeat tick that
 * starts every sweep at once therefore opens the whole pool at once. On
 * embedded Postgres that handshake is `write CONNECT_TIMEOUT <host>:<port>`
 * when the server cannot finish startup within `connect_timeout`. One slot
 * stays free so a request, a lock holder, or a health read can still check
 * out a connection.
 */
export function schedulerSweepConcurrency(poolMax = effectiveDatabasePoolMax()): number {
  if (!Number.isInteger(poolMax) || poolMax < 1) {
    throw new Error(`Database pool max must be a positive integer, got: ${poolMax}`);
  }
  return Math.max(1, poolMax - 1);
}

const HEARTBEAT_TICK_CONNECT_ATTEMPTS = 3;
const HEARTBEAT_TICK_CONNECT_BACKOFF_MS = 200;

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** postgres.js connect failure, including the Drizzle `Failed query:` wrapper. */
export function isTransientConnectTimeout(error: unknown): boolean {
  return errorChain(error).some((entry) => {
    const code = (entry as { code?: unknown }).code;
    return code === "CONNECT_TIMEOUT" || entry.message.includes("CONNECT_TIMEOUT");
  });
}

/**
 * Retry only the heartbeat timer tick, and only for CONNECT_TIMEOUT.
 * Three attempts and a short linear backoff. The next scheduler interval is
 * not allowed to stack another copy of this tick (see `createNamedSweepScheduler`).
 */
export async function runHeartbeatTickWithConnectRetry<T>(
  tick: () => Promise<T>,
  options?: {
    attempts?: number;
    backoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, error: unknown) => void;
  },
): Promise<T> {
  const attempts = options?.attempts ?? HEARTBEAT_TICK_CONNECT_ATTEMPTS;
  const backoffMs = options?.backoffMs ?? HEARTBEAT_TICK_CONNECT_BACKOFF_MS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`Heartbeat tick attempts must be a positive integer, got: ${attempts}`);
  }
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await tick();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientConnectTimeout(error)) throw error;
      options?.onRetry?.(attempt, error);
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

export function createSweepRunner(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Sweep concurrency must be a positive integer, got: ${concurrency}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  function release(): void {
    const next = waiting.shift();
    if (next) {
      // Hand the same slot to the waiter. Decrementing first would let a new
      // caller take the slot before the waiter resumes.
      next();
      return;
    }
    active -= 1;
  }

  return {
    get active() {
      return active;
    },
    async run(task: () => Promise<unknown>): Promise<void> {
      if (active >= concurrency) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * One in-flight run per sweep name. A 30s tick must not enqueue another copy
 * of a sweep that is still holding a pool slot. The name and the slot are
 * both released on success and on throw.
 */
export function createNamedSweepScheduler(concurrency: number) {
  const runner = createSweepRunner(concurrency);
  const inFlight = new Set<string>();

  return {
    get inFlightCount() {
      return inFlight.size;
    },
    has(name: string) {
      return inFlight.has(name);
    },
    start(name: string, task: () => Promise<unknown>): Promise<void> | null {
      if (inFlight.has(name)) return null;
      inFlight.add(name);
      return runner.run(async () => {
        try {
          await task();
        } finally {
          inFlight.delete(name);
        }
      });
    },
  };
}
