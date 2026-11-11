import { describe, expect, it } from "vitest";
import { ACPX_PROVIDER_QUOTA_ERROR_CODE } from "@paperclipai/adapter-utils/acpx-engine/provider-quota";
import {
  acpxProviderQuotaHeartbeatRetryNotBefore,
  classifyAcpxProviderQuotaFollowUp,
  readAcpxProviderQuotaAutomaticWakeHold,
} from "./acpx-provider-quota.js";
import {
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";

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
    // No parsed clock must not manufacture an automatic wake.
    expect(classifyAdapterFailureForRecovery(unparsed, now)).toEqual({
      kind: "provider_quota_hold",
    });
    expect(classifyContinuationFailure(unparsed as never).kind).toBe("non_retryable");
  });
});

describe("ACPX automatic hold boundaries", () => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  it.each([{}, { quotaResetAt: "not-a-date" }, {
    retryNotBefore: "2099-04-01T15:00:00.000Z",
    providerQuotaRetryNotBefore: "2099-04-01T15:00:00.000Z",
  }])("holds unknown reset without trusting old generated backoff: %j", (resultJson) => {
    const run = { errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE, error: null, resultJson };
    expect(readAcpxProviderQuotaAutomaticWakeHold(run, now)).toEqual({
      reason: "provider_quota_reset_unknown", retryNotBefore: null,
    });
    expect(classifyAdapterFailureForRecovery(run, now)).toEqual({ kind: "provider_quota_hold" });
  });
  it("holds only before an explicit reset, including exact due boundary", () => {
    const reset = "2026-11-11T13:00:00.000Z";
    const run = { errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE, resultJson: { quotaResetAt: reset } };
    expect(readAcpxProviderQuotaAutomaticWakeHold(run, now)).toEqual({
      reason: "provider_quota_reset_pending", retryNotBefore: reset,
    });
    expect(readAcpxProviderQuotaAutomaticWakeHold(run, new Date(reset))).toBeNull();
    expect(readAcpxProviderQuotaAutomaticWakeHold(run, new Date("2026-11-11T14:00:00.000Z"))).toBeNull();
  });
  it("preserves unrelated-code behavior", () => {
    expect(readAcpxProviderQuotaAutomaticWakeHold({ errorCode: "adapter_failed", resultJson: {} }, now)).toBeNull();
    expect(classifyAdapterFailureForRecovery({ errorCode: "adapter_failed", error: "unrelated failure", resultJson: {} }, now)).toBeNull();
  });
});
