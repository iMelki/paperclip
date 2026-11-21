/**
 * Usage reporting for hermes_local.
 *
 * Hermes does not print token counts or cost in a chat run, so the adapter used to report none and
 * Paperclip budgets could never trip. Hermes keeps them in its session store; `hermes sessions
 * export --session-id <id> --format jsonl <file>` writes one record per session with the model, the
 * billing provider, token counts and a cost with a status ("actual", "estimated" or "unknown").
 * The adapter reads that record after the run. A resumed session is cumulative, so the adapter keeps
 * a baseline in its session parameters and reports only this run's share.
 */
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { UsageSummary } from "@paperclipai/adapter-utils";

/**
 * A counter is null when the record did not report a valid value. Unknown is never zero: a missing
 * measurement must not read as "used nothing", so every consumer treats a null counter as unknown.
 */
export interface HermesSessionUsage {
  sessionId: string;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Known cost in USD, or null when Hermes cannot price the model or the cost is missing or invalid. */
  costUsd: number | null;
  costStatus: string | null;
}

/** What the previous run of the same session had already used; stored in the session parameters. */
export interface HermesUsageBaseline {
  sessionId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
}

/** Why usage could not be read. A budget check must treat each of these as unknown, never as zero. */
export type UsageUnavailableReason =
  | "no_session_id" | "export_timed_out" | "export_failed" | "record_unreadable"
  | "record_incomplete" | "baseline_unusable" | "counter_regressed";

export interface HermesRunUsage {
  /** This run's tokens, or null when they cannot be determined (see unknownReason). */
  usage: UsageSummary | null;
  usageBasis: "per_run" | "session_cumulative" | null;
  costUsd: number | null;
  unknownReason: UsageUnavailableReason | null;
  /** Baseline to store for the next run; null keeps the previous baseline of this session unchanged. */
  nextBaseline: HermesUsageBaseline | null;
}

/** A finite, non-negative number, else null. Missing, blank, null and malformed values are null, not 0. */
const asCount = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Reads the first session record of a `sessions export --format jsonl` file; null when unusable. */
export function parseHermesSessionExport(text: string): HermesSessionUsage | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = asText(record.id);
  if (!sessionId) return null;
  const costStatus = asText(record.cost_status);
  // The cost stays null unless the status names a cost field and that field holds a valid number.
  let costUsd: number | null = null;
  if (costStatus === "actual") costUsd = asCount(record.actual_cost_usd);
  else if (costStatus === "estimated") costUsd = asCount(record.estimated_cost_usd);
  return {
    sessionId,
    model: asText(record.model),
    provider: asText(record.billing_provider),
    inputTokens: asCount(record.input_tokens),
    outputTokens: asCount(record.output_tokens),
    cachedInputTokens: asCount(record.cache_read_tokens),
    costUsd,
    costStatus,
  };
}

export function readUsageBaseline(sessionParams: unknown): HermesUsageBaseline | null {
  if (typeof sessionParams !== "object" || sessionParams === null) return null;
  const raw = (sessionParams as Record<string, unknown>).usageBaseline;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = asText(record.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    inputTokens: asCount(record.inputTokens),
    outputTokens: asCount(record.outputTokens),
    cachedInputTokens: asCount(record.cachedInputTokens),
    costUsd: asCount(record.costUsd),
  };
}

export function toUsageBaseline(current: HermesSessionUsage): HermesUsageBaseline {
  return {
    sessionId: current.sessionId,
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    cachedInputTokens: current.cachedInputTokens,
    costUsd: current.costUsd,
  };
}

const unknownRun = (
  unknownReason: UsageUnavailableReason, nextBaseline: HermesUsageBaseline | null,
): HermesRunUsage => ({ usage: null, usageBasis: null, costUsd: null, unknownReason, nextBaseline });

/**
 * This run's share of the session totals. A fresh session counts in full. A resumed session with a
 * matching baseline reports the difference. A resumed session without one reports the cumulative
 * tokens, marked as such so the server takes the delta, and no cost (it cannot be split safely).
 *
 * Unknown is never zero. Incomplete counters, an unusable baseline, or a counter that went DOWN make
 * the run's usage unknown. After a regression the previous (higher) baseline is kept, so a later,
 * higher reading reports only what lies above the old watermark.
 */
export function computeRunUsage(
  current: HermesSessionUsage,
  previous: HermesUsageBaseline | null,
  resumedSessionId: string | null,
): HermesRunUsage {
  const { inputTokens, outputTokens, cachedInputTokens } = current;
  if (inputTokens === null || outputTokens === null || cachedInputTokens === null) {
    return unknownRun("record_incomplete", null);
  }
  const totals: UsageSummary = { inputTokens, outputTokens, cachedInputTokens };
  const reanchor = toUsageBaseline(current);
  if (!resumedSessionId) {
    return { usage: totals, usageBasis: "per_run", costUsd: current.costUsd, unknownReason: null, nextBaseline: reanchor };
  }
  if (!previous || previous.sessionId !== current.sessionId) {
    return { usage: totals, usageBasis: "session_cumulative", costUsd: null, unknownReason: null, nextBaseline: reanchor };
  }
  if (previous.inputTokens === null || previous.outputTokens === null || previous.cachedInputTokens === null) {
    // Subtracting an unknown baseline as zero would count earlier usage of the session again. The
    // valid per-field watermarks survive, so what this unknown run saw is recovered by a later read.
    return unknownRun("baseline_unusable", mergeUnusableBaseline(current, previous));
  }
  if (inputTokens < previous.inputTokens || outputTokens < previous.outputTokens
    || cachedInputTokens < previous.cachedInputTokens) {
    return unknownRun("counter_regressed", null);
  }
  const bothCosts = current.costUsd !== null && previous.costUsd !== null;
  const costRegressed = bothCosts && (current.costUsd as number) < (previous.costUsd as number);
  return {
    usage: {
      inputTokens: inputTokens - previous.inputTokens,
      outputTokens: outputTokens - previous.outputTokens,
      cachedInputTokens: cachedInputTokens - previous.cachedInputTokens,
    },
    usageBasis: "per_run",
    costUsd: bothCosts && !costRegressed ? (current.costUsd as number) - (previous.costUsd as number) : null,
    unknownReason: null,
    // The cost watermark moves only on a valid, non-regressed cost; an unknown cost keeps the last one.
    nextBaseline: { ...reanchor, costUsd: costWatermark(current.costUsd, previous.costUsd) },
  };
}

/** Last valid cost watermark: advances on a valid, non-lower cost; an unknown or lower cost keeps the old one. */
function costWatermark(current: number | null, previous: number | null): number | null {
  if (current === null) return previous;
  if (previous === null) return current;
  return current < previous ? previous : current;
}

/**
 * Baseline after a run whose stored baseline had an invalid counter. That run reports nothing, so its
 * usage is not accounted: every valid stored counter stays where it is (a later read recovers the gap),
 * and only a counter with no valid stored value is anchored at the current reading, because there is
 * nothing earlier to recover it from. The cost watermark is kept independently of the tokens.
 */
function mergeUnusableBaseline(current: HermesSessionUsage, previous: HermesUsageBaseline): HermesUsageBaseline {
  return {
    sessionId: current.sessionId,
    inputTokens: previous.inputTokens ?? current.inputTokens,
    outputTokens: previous.outputTokens ?? current.outputTokens,
    cachedInputTokens: previous.cachedInputTokens ?? current.cachedInputTokens,
    costUsd: costWatermark(current.costUsd, previous.costUsd),
  };
}

export interface ReadSessionUsageOptions {
  command: string;
  /** Arguments that precede the subcommand, e.g. ["--profile", "name"] in strict isolation. */
  argsPrefix: string[];
  env: Record<string, string>;
  inheritEnv: boolean;
  cwd: string;
  runId: string;
  sessionId: string;
  timeoutSec: number;
}

export type HermesUsageOutcome =
  | { status: "ok"; usage: HermesSessionUsage }
  | { status: "unavailable"; reason: UsageUnavailableReason };

export const USAGE_UNAVAILABLE_TEXT: Record<UsageUnavailableReason, string> = {
  no_session_id: "Hermes printed no session id, so there is no session record to read",
  export_timed_out: "reading the session record timed out",
  export_failed: "reading the session record failed",
  record_unreadable: "the session record could not be parsed",
  record_incomplete: "the session record has missing or invalid token counters",
  baseline_unusable: "the stored usage baseline of this session has missing or invalid counters",
  counter_regressed: "a cumulative counter went down compared with the stored baseline",
};

/**
 * Runs `sessions export` for one session and parses it. Never throws: usage is best effort, but the
 * outcome always says whether usage is known, so a failure is reported as unknown and not as zero.
 */
export async function readHermesSessionUsage(options: ReadSessionUsageOptions): Promise<HermesUsageOutcome> {
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-usage-"));
    const file = path.join(dir, "session.jsonl");
    const result = await runChildProcess(`${options.runId}:usage`, options.command, [
      ...options.argsPrefix, "sessions", "export", "--session-id", options.sessionId, "--format", "jsonl", file,
    ], {
      cwd: options.cwd,
      env: options.env,
      inheritEnv: options.inheritEnv,
      timeoutSec: options.timeoutSec,
      graceSec: 5,
      onLog: async () => undefined,
    });
    if (result.timedOut) return { status: "unavailable", reason: "export_timed_out" };
    if (result.exitCode !== 0) return { status: "unavailable", reason: "export_failed" };
    const parsed = parseHermesSessionExport(await fs.readFile(file, "utf8"));
    return parsed && parsed.sessionId === options.sessionId
      ? { status: "ok", usage: parsed }
      : { status: "unavailable", reason: "record_unreadable" };
  } catch {
    return { status: "unavailable", reason: "export_failed" };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
