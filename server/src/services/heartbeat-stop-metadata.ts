import {
  adapterDefaultTimeoutSec,
  resolveAdapterTimeoutSec,
  resolveHttpAdapterTimeout,
} from "@paperclipai/adapter-utils/adapter-timeout";

export type HeartbeatRunOutcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

export type HeartbeatRunStopReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "unmanaged_background_task_stopped"
  | "adapter_failed";

export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  timeoutConfigured: boolean;
  timeoutSource: "config" | "env" | "default" | "unknown";
}

export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

function heartbeatTimeoutSource(
  source: "configured" | "env" | "adapter_default",
): HeartbeatRunTimeoutPolicy["timeoutSource"] {
  if (source === "configured") return "config";
  if (source === "env") return "env";
  return "default";
}

export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const resolved = resolveHttpAdapterTimeout({
      timeoutSec: config.timeoutSec,
      timeoutMs: config.timeoutMs,
    });
    return {
      effectiveTimeoutSec: resolved.timeoutMs / 1000,
      effectiveTimeoutMs: resolved.timeoutMs,
      timeoutConfigured: resolved.source === "configured",
      timeoutSource: heartbeatTimeoutSource(resolved.source),
    };
  }

  const resolved = resolveAdapterTimeoutSec({
    configured: config.timeoutSec,
    adapterDefaultSec: adapterDefaultTimeoutSec(adapterType),
  });

  return {
    effectiveTimeoutSec: resolved.timeoutSec,
    timeoutConfigured: resolved.source === "configured",
    timeoutSource: heartbeatTimeoutSource(resolved.source),
  };
}

export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  if (input.outcome === "interrupted") return "interrupted";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "unmanaged_background_task_stopped") return "unmanaged_background_task_stopped";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig);
  const stopReason = inferHeartbeatRunStopReason(input);
  return {
    ...timeoutPolicy,
    stopReason,
    timeoutFired: stopReason === "timeout",
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  return {
    ...(resultJson ?? {}),
    stopReason: existingMaxTurnStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: metadata.effectiveTimeoutSec,
    timeoutConfigured: metadata.timeoutConfigured,
    timeoutSource: metadata.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    ...(metadata.effectiveTimeoutMs != null ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
