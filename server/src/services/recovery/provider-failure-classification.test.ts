import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it.each(["adapter_failed", "acpx_turn_failed"])(
    "waits for the explicit Claude session reset on %s instead of retrying immediately",
    (errorCode) => {
      const now = new Date("2026-10-13T18:00:38.000Z");
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "Internal error: You've hit your session limit · resets 10:40pm (Asia/Jerusalem)",
        resultJson: { mode: "persistent", status: "failed", stopReason: "adapter_failed" },
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date("2026-10-13T19:40:00.000Z"),
        parsedResetTime: true,
      });
    },
  );

  it("uses the explicit reset clock from the ACP result summary", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Provider turn failed",
      resultJson: { summary: "You've hit your session limit - resets at 21:30 (UTC)" },
    }, new Date("2026-10-13T18:00:00.000Z"))).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("does not classify an ordinary ACP turn error as a quota wait", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "The agent failed while reading a workspace file",
      resultJson: { status: "failed" },
    })).toBeNull();
  });

  it.each([
    "Browser tool error: session limit reached (max 5 concurrent sessions)",
    "MCP server rejected the request: session limit exceeded for this workspace",
    "Terminal session limit is 4; close a terminal and try again",
  ])("does not treat generic ACP session-limit wording as a provider quota: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error,
      resultJson: { status: "failed" },
    })).toBeNull();
  });

  it("does not turn a non-adapter session-limit message into an automatic retry", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "issue_paused",
      error: "You've hit your session limit - resets 10:40pm (Asia/Jerusalem)",
      resultJson: null,
    })).toBeNull();
  });

  it("keeps quota recovery bounded when the provider supplies no reset clock", () => {
    const now = new Date("2026-10-13T18:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your session limit",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("ignores quota and credential wording that only appears in an ACP transcript", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    for (const text of [
      "The docs say: usage limit exceeded means retry later.",
      "Set the key: API key is not set in the sample config.",
      "quota exceeded and missing credentials are listed in the test names.",
    ]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "acpx_turn_failed",
        error: "Process exited with code 1",
        resultJson: { stopReason: "error", summary: "done", transcript: [{ text }], output: text },
      }, now)).toBeNull();
    }
  });

  it("takes the exact Claude statement from the ACP summary or stop reason", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    for (const resultJson of [
      { summary: "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)" },
      { stopReason: "You\u2019ve hit your session limit · resets 10:40pm (Asia/Jerusalem)" },
    ]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "acpx_turn_failed",
        error: null,
        resultJson,
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date("2026-10-13T19:40:00.000Z"),
        parsedResetTime: true,
      });
    }
  });

  it("ignores reset clocks that are far from the quota statement or lack a word boundary", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const far = `You've hit your session limit.${" x".repeat(100)} resets 10:40pm (Asia/Jerusalem)`;
    const glued = "You've hit your session limit. See presets 10:40pm for options";
    for (const error of [far, glued]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error,
        resultJson: {},
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
        parsedResetTime: false,
      });
    }
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});
