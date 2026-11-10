import { describe, expect, it } from "vitest";
import { ACPX_PROVIDER_QUOTA_ERROR_CODE } from "@paperclipai/adapter-utils/acpx-engine/provider-quota";
import {
  acpxProviderQuotaHeartbeatRetryNotBefore,
  classifyAcpxProviderQuotaFollowUp,
} from "./acpx-provider-quota.js";
import { classifyAdapterFailureForRecovery, classifyContinuationFailure } from "./service.js";

describe("ACPX provider quota follow-up", () => {
  it("does not retry or wake a run with the quota code before the parsed reset", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    const reset = new Date("2099-04-01T15:00:00.000Z");
    const run = {
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      error: "Internal error: You've hit your session limit — resets 10:40pm (Asia/Jerusalem)",
      resultJson: { quotaResetAt: reset.toISOString() },
      status: "failed" as const,
    };

    expect(classifyAcpxProviderQuotaFollowUp(run, now)).toEqual({
      applies: true,
      retry: false,
      wake: false,
      notBefore: reset,
    });
    expect(acpxProviderQuotaHeartbeatRetryNotBefore(run, now)).toEqual(reset);
    expect(classifyAdapterFailureForRecovery(run, now)).toEqual({
      kind: "provider_quota",
      retryAt: reset,
      parsedResetTime: true,
    });
    expect(classifyContinuationFailure(run as never).kind).toBe("non_retryable");

    const unparsed = {
      ...run,
      resultJson: { quotaResetAt: null },
    };
    expect(classifyAcpxProviderQuotaFollowUp(unparsed, now)).toEqual({
      applies: true,
      retry: false,
      wake: false,
      notBefore: null,
    });
    expect(acpxProviderQuotaHeartbeatRetryNotBefore(unparsed, now)).toBeNull();
    expect(classifyAdapterFailureForRecovery(unparsed, now)).toEqual({
      kind: "acpx_provider_quota_hold",
    });
    expect(classifyContinuationFailure(unparsed as never).kind).toBe("non_retryable");
  });
});
