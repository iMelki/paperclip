import { ACPX_PROVIDER_QUOTA_ERROR_CODE } from "@paperclipai/adapter-utils/acpx-engine/provider-quota";
import { parseObject } from "../../adapters/utils.js";

export { ACPX_PROVIDER_QUOTA_ERROR_CODE };

export type AcpxProviderQuotaFollowUp = {
  /** True when the run ended with the ACPX provider-quota code. */
  applies: boolean;
  /**
   * False until `notBefore`, and false for the whole run when no reset was
   * parsed. Heartbeat retry and auto-wake both honor this.
   */
  retry: boolean;
  wake: boolean;
  /**
   * Earliest instant a retry or wake may run. Null when the reset clock was
   * not parsed: do not retry and do not wake.
   */
  notBefore: Date | null;
};

export function readAcpxProviderQuotaResetAt(resultJson: unknown): Date | null {
  const value = parseObject(resultJson).quotaResetAt;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Shared decision for the heartbeat retry scheduler and the recovery wake.
 * A parsed reset may run at `notBefore` and not before it. No parsed reset
 * never retries and never wakes.
 */
export function classifyAcpxProviderQuotaFollowUp(
  run: { errorCode?: string | null; resultJson?: unknown },
  now: Date,
): AcpxProviderQuotaFollowUp {
  if (run.errorCode !== ACPX_PROVIDER_QUOTA_ERROR_CODE) {
    return { applies: false, retry: false, wake: false, notBefore: null };
  }
  const notBefore = readAcpxProviderQuotaResetAt(run.resultJson);
  if (!notBefore) {
    return { applies: true, retry: false, wake: false, notBefore: null };
  }
  const due = now.getTime() >= notBefore.getTime();
  return { applies: true, retry: due, wake: due, notBefore };
}

/** Unknown reset holds automatic work; a known reset releases only when due. */
export function readAcpxProviderQuotaAutomaticWakeHold(
  run: { errorCode?: string | null; resultJson?: unknown } | null | undefined,
  now = new Date(),
) {
  if (!run) return null;
  const followUp = classifyAcpxProviderQuotaFollowUp(run, now);
  if (!followUp.applies || followUp.wake) return null;
  return {
    reason: followUp.notBefore ? "provider_quota_reset_pending" : "provider_quota_reset_unknown",
    retryNotBefore: followUp.notBefore?.toISOString() ?? null,
  };
}

/**
 * Earliest heartbeat retry time for this code. Null means the bounded retry
 * scheduler must not enqueue a retry.
 */
export function acpxProviderQuotaHeartbeatRetryNotBefore(
  run: { errorCode?: string | null; resultJson?: unknown },
  now: Date,
): Date | null {
  const followUp = classifyAcpxProviderQuotaFollowUp(run, now);
  if (!followUp.applies) return null;
  return followUp.notBefore;
}
