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

  it("parses a whole-hour reset when the clock carries an explicit timezone", () => {
    // sessionNow is 18:00 UTC, so the next 21:00 UTC is the same day.
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit · resets 21 (UTC)",
      sessionNow,
    )).toEqual({
      errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
      quotaResetAt: "2026-10-13T21:00:00.000Z",
    });
    expect(classifyAcpxProviderQuotaTurn(
      "usage limit exceeded, resets 9 GMT",
      sessionNow,
    )?.quotaResetAt).toBe("2026-10-14T09:00:00.000Z");
    // A bare number, or a number followed by something that is not a zone, is prose.
    for (const message of [
      "You've hit your session limit · resets 9",
      "You've hit your session limit · resets 7 (days)",
    ]) {
      expect(classifyAcpxProviderQuotaTurn(message, sessionNow)).toEqual({
        errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
        quotaResetAt: null,
      });
    }
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

describe("quota reset timezone boundaries", () => {
  it("does not accept a bare UTC or GMT prefix of a signed offset", () => {
    for (const zone of ["GMT-05:00", "UTC+02:00", "GMT +05:30", "UTC−03:00"]) {
      expect(classifyAcpxProviderQuotaTurn(
        `You've hit your session limit — resets 9pm ${zone}`,
        sessionNow,
      )?.quotaResetAt, zone).toBeNull();
    }
    for (const zone of ["UTC", "GMT"]) {
      expect(classifyAcpxProviderQuotaTurn(
        `You've hit your session limit — resets 9pm ${zone}`,
        sessionNow,
      )?.quotaResetAt, zone).toBe("2026-10-13T21:00:00.000Z");
    }
  });

  it("uses the remaining New York fall-back occurrence before tomorrow", () => {
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit — resets 1:30am (America/New_York)",
      new Date("2026-11-01T06:20:00.000Z"),
    )?.quotaResetAt).toBe("2026-11-01T06:30:00.000Z");
  });

  it("handles Lord Howe's half-hour fall-back without assuming a one-hour shift", () => {
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit — resets 1:45am (Australia/Lord_Howe)",
      new Date("2026-04-04T15:05:00.000Z"),
    )?.quotaResetAt).toBe("2026-04-04T15:15:00.000Z");
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit — resets 1:45am (Australia/Lord_Howe)",
      new Date("2026-04-04T15:20:00.000Z"),
    )?.quotaResetAt).toBe("2026-04-04T15:15:00.000Z");
  });

  it("keeps the elapsed grace and rolls past both repeated occurrences", () => {
    const message = "You've hit your session limit — resets 1:30am (America/New_York)";
    expect(classifyAcpxProviderQuotaTurn(message, new Date("2026-11-01T06:40:00.000Z"))?.quotaResetAt)
      .toBe("2026-11-01T06:30:00.000Z");
    expect(classifyAcpxProviderQuotaTurn(message, new Date("2026-11-01T07:10:00.000Z"))?.quotaResetAt)
      .toBe("2026-11-02T06:30:00.000Z");
  });

  it("never invents the missing local clock during a spring-forward gap", () => {
    expect(classifyAcpxProviderQuotaTurn(
      "You've hit your session limit — resets 2:30am (America/New_York)",
      new Date("2026-03-08T06:00:00.000Z"),
    )?.quotaResetAt).toBe("2026-03-09T06:30:00.000Z");
  });
});


it("prefers the future overlap occurrence over an earlier clock within grace", () => {
  expect(classifyAcpxProviderQuotaTurn(
    "You've hit your session limit — resets 1:30am (America/New_York)",
    new Date("2026-11-01T05:50:00.000Z"),
  )?.quotaResetAt).toBe("2026-11-01T06:30:00.000Z");
});
