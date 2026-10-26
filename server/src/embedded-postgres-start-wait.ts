/**
 * Start-up wait for embedded PostgreSQL that follows crash-recovery progress.
 *
 * On Windows the patched embedded-postgres starts the server through
 * `pg_ctl start -w -t 60`. After an unclean shutdown, PostgreSQL first runs
 * crash recovery (fsync of the data directory, then WAL redo). On a loaded
 * host the fsync step alone can take longer than 60 s, so pg_ctl stops
 * waiting and `start()` rejects although the server is still recovering and
 * will become ready. pg_ctl does not stop the server when its wait ends.
 *
 * This helper keeps waiting in that case, but only while the server log shows
 * recovery and the recovery keeps making progress, and never past a hard upper
 * bound. While the outcome is unknown, and after a give-up, it disarms the
 * instance's `stop()` so that the dependency's process-exit hook cannot shut
 * the server down in the middle of recovery (a shut-down recovery restarts
 * from zero on the next start).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Server log lines that show crash recovery has started or moved forward. */
export const RECOVERY_PROGRESS_PATTERNS: readonly RegExp[] = [
  /database system was interrupted/i,
  /database system was not properly shut down; automatic recovery in progress/i,
  /syncing data directory/i,
  /redo starts at/i,
  /redo in progress/i,
  /redo done at/i,
  /checkpoint starting: end-of-recovery/i,
];

export const DEFAULT_RECOVERY_MAX_WAIT_SECONDS = 1800;
export const DEFAULT_RECOVERY_STALL_SECONDS = 300;
const DEFAULT_POLL_MS = 1000;

export type RecoveryWaitPolicy = {
  /** Hard upper bound, measured from the start of `start()`. */
  maxWaitMs: number;
  /** Give up when no new recovery progress line appears for this long. */
  stallMs: number;
  pollMs: number;
};

export type RecoveryGiveUpReason = "upper-bound" | "stalled" | "exited";

/** Start failed during crash recovery; the message names the server log. */
export class EmbeddedPostgresRecoveryIncomplete extends Error {
  constructor(
    message: string,
    readonly reason: RecoveryGiveUpReason,
    readonly serverLogPath: string,
    readonly leftRunning: boolean,
    readonly startError: unknown,
  ) {
    super(message);
    this.name = "EmbeddedPostgresRecoveryIncomplete";
  }
}

/** The part of an embedded-postgres instance this helper uses. */
export type RecoverableEmbeddedPostgres = {
  start(): Promise<void>;
  /** The vendor's `stop()` returns at once while this is unset. */
  process?: unknown;
};

export type StartFollowingRecoveryInput = {
  instance: RecoverableEmbeddedPostgres;
  serverLogPath: string;
  policy: RecoveryWaitPolicy;
  readServerLog: () => Promise<string | null>;
  isPostmasterAlive: () => Promise<boolean>;
  isReady: () => Promise<boolean>;
  /** Called when the wait begins and each time a new recovery progress line appears. */
  onRecoveryWait?: (info: { progressLines: number; waitedMs: number }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type StartFollowingRecoveryResult = { followedRecovery: boolean; waitedMs: number };

export function countRecoveryProgressLines(log: string | null): number {
  if (!log) return 0;
  return log
    .split(/\r?\n/)
    .filter((line) => RECOVERY_PROGRESS_PATTERNS.some((pattern) => pattern.test(line))).length;
}

/**
 * True while the PID in `postmaster.pid` is a live process. A missing or
 * unreadable file, a malformed PID, or ESRCH means it is gone; any other probe
 * error (for example EPERM) leaves it presumed alive.
 */
export async function isPostmasterPidAlive(
  pidFile: string,
  probe: (pid: number) => void = (pid) => process.kill(pid, 0),
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(pidFile, "utf8");
  } catch {
    return false;
  }
  const pid = Number(contents.split(/\r?\n/)[0]?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * The file pg_ctl writes the server log to on Windows: the instance's
 * `logFile` option when it has one, otherwise `server.log` in the data
 * directory (the current patched embedded-postgres default).
 */
export function embeddedPostgresServerLogPath(
  instance: { options?: { logFile?: unknown } },
  dataDir: string,
): string {
  const configured = instance.options?.logFile;
  return typeof configured === "string" && configured.length > 0
    ? resolve(configured)
    : join(resolve(dataDir), "server.log");
}

function readSeconds(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * Reads the policy from `PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_MAX_WAIT_SEC`
 * (60-86400, default 1800) and `PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_STALL_SEC`
 * (30-3600, default 300). A missing or invalid value uses the default.
 */
export function resolveRecoveryWaitPolicy(env: NodeJS.ProcessEnv = process.env): RecoveryWaitPolicy {
  const maxSeconds = readSeconds(
    env.PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_MAX_WAIT_SEC,
    DEFAULT_RECOVERY_MAX_WAIT_SECONDS,
    60,
    86400,
  );
  const stallSeconds = readSeconds(
    env.PAPERCLIP_EMBEDDED_POSTGRES_RECOVERY_STALL_SEC,
    DEFAULT_RECOVERY_STALL_SECONDS,
    30,
    3600,
  );
  return { maxWaitMs: maxSeconds * 1000, stallMs: stallSeconds * 1000, pollMs: DEFAULT_POLL_MS };
}

function giveUp(
  reason: RecoveryGiveUpReason,
  input: StartFollowingRecoveryInput,
  waitedMs: number,
  startError: unknown,
): EmbeddedPostgresRecoveryIncomplete {
  const log = input.serverLogPath;
  const seconds = Math.round(waitedMs / 1000);
  if (reason === "exited") {
    return new EmbeddedPostgresRecoveryIncomplete(
      `Embedded PostgreSQL exited during crash recovery after ${seconds} s. Read the server log at ${log}.`,
      reason, log, false, startError,
    );
  }
  const why = reason === "stalled"
    ? `no recovery progress was logged for ${Math.round(input.policy.stallMs / 1000)} s`
    : `the upper bound of ${Math.round(input.policy.maxWaitMs / 1000)} s was reached`;
  return new EmbeddedPostgresRecoveryIncomplete(
    `Embedded PostgreSQL did not become ready after ${seconds} s of crash recovery (${why}). ` +
      `Paperclip did not stop PostgreSQL, so recovery can continue. Read the server log at ${log}; ` +
      `start Paperclip again after it shows "database system is ready to accept connections".`,
    reason, log, true, startError,
  );
}

async function followRecovery(
  input: StartFollowingRecoveryInput,
  startedAt: number,
  progressLines: number,
  startError: unknown,
): Promise<number> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let progress = progressLines;
  let lastProgressAt = now();
  input.onRecoveryWait?.({ progressLines: progress, waitedMs: lastProgressAt - startedAt });
  for (;;) {
    const waitedMs = now() - startedAt;
    if (await input.isReady().catch(() => false)) return waitedMs;
    if (!(await input.isPostmasterAlive())) throw giveUp("exited", input, waitedMs, startError);
    const current = countRecoveryProgressLines(await input.readServerLog().catch(() => null));
    if (current > progress) {
      progress = current;
      lastProgressAt = now();
      input.onRecoveryWait?.({ progressLines: progress, waitedMs });
    }
    if (now() - lastProgressAt >= input.policy.stallMs) throw giveUp("stalled", input, waitedMs, startError);
    if (waitedMs >= input.policy.maxWaitMs) throw giveUp("upper-bound", input, waitedMs, startError);
    await sleep(input.policy.pollMs);
  }
}

/**
 * Runs `instance.start()`. When it fails while the server log shows crash
 * recovery and the postmaster is alive, keeps waiting for readiness as long as
 * recovery makes progress, up to the hard upper bound. Any other failure is
 * rethrown unchanged. A give-up during recovery leaves PostgreSQL running and
 * its `stop()` disarmed, and throws `EmbeddedPostgresRecoveryIncomplete`.
 */
export async function startEmbeddedPostgresFollowingRecovery(
  input: StartFollowingRecoveryInput,
): Promise<StartFollowingRecoveryResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  try {
    await input.instance.start();
    return { followedRecovery: false, waitedMs: now() - startedAt };
  } catch (startError) {
    // Disarm first: until readiness is known, a process-exit hook must not stop the server.
    const handle = input.instance.process;
    input.instance.process = undefined;
    const progressLines = countRecoveryProgressLines(await input.readServerLog().catch(() => null));
    if (progressLines === 0 || !(await input.isPostmasterAlive())) {
      input.instance.process = handle;
      throw startError;
    }
    const waitedMs = await followRecovery(input, startedAt, progressLines, startError);
    input.instance.process = handle;
    return { followedRecovery: true, waitedMs };
  }
}
