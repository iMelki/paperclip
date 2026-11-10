import { describe, expect, it } from "vitest";
import {
  ACPX_PROVIDER_QUOTA_ERROR_CODE,
  classifyAcpxProviderQuotaTurn,
} from "./provider-quota.js";

const sessionNow = new Date("2026-10-13T18:00:38.000Z");
const REAL_SESSION_LIMIT =
  "Internal error: You've hit your session limit — resets 10:40pm (Asia/Jerusalem)";

describe("classifyAcpxProviderQuotaTurn", () => {
  it("maps the real session-limit message and parses the reset time", () => {
    expect(classifyAcpxProviderQuotaTurn(REAL_SESSION_LIMIT, sessionNow)).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: "2026-10-13T19:40:00.000Z",
    });
  });

  it("maps a usage-limit variant and parses its reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      now,
    )).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: "2026-07-15T21:30:00.000Z",
    });
  });

  it("keeps an unrelated turn error on acpx_turn_failed", () => {
    expect(classifyAcpxProviderQuotaTurn(
      "The agent failed while reading a workspace file",
      sessionNow,
    )).toBeNull();
    expect(classifyAcpxProviderQuotaTurn(
      "Browser tool error: session limit reached (max 5 concurrent sessions)",
      sessionNow,
    )).toBeNull();
  });

  it("maps quota wording and leaves the reset null when the clock cannot be parsed", () => {
    expect(classifyAcpxProviderQuotaTurn("You've hit your session limit", sessionNow)).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: null,
    });
    expect(classifyAcpxProviderQuotaTurn(
      "quota exceeded — resets sometime tomorrow",
      sessionNow,
    )).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: null,
    });
    expect(classifyAcpxProviderQuotaTurn(
      "usage limit exceeded. Try again at 4:30 PM.",
      sessionNow,
    )).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: null,
    });
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit · resets 10:40pm (Foo/Bar)",
      sessionNow,
    )).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: null,
    });
  });

  it("does not treat local resource quotas or loose wording as a provider limit", () => {
    for (const message of [
      "EDQUOT: Disk quota exceeded",
      "write failed: disk quota exceeded",
      "Cloud storage quota exceeded for this bucket",
      "The workspace has hit its file quota exceeded limit",
      "Tool notice: usage limitations apply to this endpoint",
      "usage limit",
      "the usage limiter rejected the call",
    ]) {
      expect(classifyAcpxProviderQuotaTurn(message, sessionNow), message).toBeNull();
    }
  });

  it("still maps a provider quota statement that names no local resource", () => {
    for (const message of [
      "Quota exceeded for quota metric 'Generate Content API requests per minute'",
      "usage-limit-reached for this account",
      "Usage limit exceeded",
    ]) {
      expect(classifyAcpxProviderQuotaTurn(message, sessionNow)?.errorCode, message)
        .toBe(ACPX_PROVIDER_QUOTA_ERROR_CODE);
    }
  });

  it("parses a reset clock whose timezone ends after the 120 character window", () => {
    const filler = " ".repeat(100);
    const message = `You've hit your session limit${filler}resets 10:40pm (Asia/Jerusalem)`;
    expect(classifyAcpxProviderQuotaTurn(message, sessionNow)).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: "2026-10-13T19:40:00.000Z",
    });
    // A clock that starts beyond the window is not this statement's reset.
    const far = `You've hit your session limit${" ".repeat(130)}resets 10:40pm (Asia/Jerusalem)`;
    expect(classifyAcpxProviderQuotaTurn(far, sessionNow)?.quotaResetAt).toBeNull();
  });
});
