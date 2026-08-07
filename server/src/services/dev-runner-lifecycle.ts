export type DevRunnerChildOutcome = {
  code: number;
  signal: NodeJS.Signals | null;
};

export type DevRunnerExitRoute =
  | { action: "ignored"; pending: null; exitNow: null }
  | { action: "deferred"; pending: DevRunnerChildOutcome; exitNow: null }
  | { action: "exit"; pending: null; exitNow: DevRunnerChildOutcome };

export function routeDevRunnerChildExit(input: {
  restartInFlight: boolean;
  expected: boolean;
  shuttingDown: boolean;
  outcome: DevRunnerChildOutcome;
}): DevRunnerExitRoute {
  if (input.expected || input.shuttingDown) {
    return { action: "ignored", pending: null, exitNow: null };
  }
  if (input.restartInFlight) {
    return {
      action: "deferred",
      pending: { ...input.outcome },
      exitNow: null,
    };
  }
  return {
    action: "exit",
    pending: null,
    exitNow: { ...input.outcome },
  };
}

export function flushDevRunnerPendingExit(input: {
  restartInFlight: boolean;
  shuttingDown: boolean;
  hasChild: boolean;
  pending: DevRunnerChildOutcome | null;
}) {
  if (
    input.restartInFlight
    || input.shuttingDown
    || input.hasChild
    || !input.pending
  ) {
    return { pending: input.pending, exitNow: null };
  }
  return {
    pending: null,
    exitNow: { ...input.pending },
  };
}

export async function waitForDevRunnerOutcomeBounded<T>(input: {
  pending: Promise<T>;
  timeoutMs: number;
  timeoutError: () => Error;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(input.timeoutError()), input.timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function completeClaimedDevRunnerShutdown<T>(input: {
  signalChild: () => boolean;
  signalRejectedError: () => Error;
  waitForExit: () => Promise<T>;
  releaseClaim: () => Promise<void>;
}): Promise<T> {
  if (!input.signalChild()) {
    throw input.signalRejectedError();
  }
  const outcome = await input.waitForExit();
  await input.releaseClaim();
  return outcome;
}
