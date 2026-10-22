import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

const PROVIDER_QUOTA_WINDOW_FOR_TEST = 120;

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

  it("uses the explicit reset clock from the ACP stop reason", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Provider turn failed",
      resultJson: { stopReason: "You've hit your session limit - resets at 21:30 (UTC)" },
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

  it("does not read quota evidence from the ACP summary, which can quote the statement", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Process exited with code 1",
      resultJson: { summary: "Added a test for \"You've hit your session limit · resets 10:40pm (Asia/Jerusalem)\"" },
    }, new Date("2026-10-13T18:00:38.000Z"))).toBeNull();
  });

  it.each(["adapter_failed"])(
    "does not park a %s run (Codex and other non-ACP adapters) that only quotes the Claude session statement in its result",
    (errorCode) => {
      const quote = "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)";
      for (const resultJson of [
        { summary: `Added a test for "${quote}"` },
        { stdout: `$ grep -r "${quote}" src\n` },
        { transcript: [{ role: "assistant", text: quote }] },
      ]) {
        expect(classifyAdapterFailureForRecovery({
          errorCode,
          error: "Process exited with code 1",
          resultJson,
        }, new Date("2026-10-13T18:00:38.000Z"))).toBeNull();
      }
    },
  );

  it("still reads the session statement from a non-ACP run's own error field", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)",
      resultJson: { summary: "Quoted again: You've hit your session limit · resets 9:00am (UTC)" },
    }, new Date("2026-10-13T18:00:38.000Z"))).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T19:40:00.000Z"),
      parsedResetTime: true,
    });
  });

  describe("a reset clock comes only from the run's own error or ACP evidence", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const defaultBackoff = {
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    };

    it("ignores a reset clock or 'try again at' that a result summary quotes when the own error has no clock", () => {
      for (const summary of [
        "Quoted: You've hit your session limit · resets 9:00am (UTC)",
        "Quoted: you've hit your session limit. Try again at 9:00 AM (UTC).",
        "Added a test for resets 21:30 (UTC)",
      ]) {
        expect(classifyAdapterFailureForRecovery({
          errorCode: "adapter_failed",
          error: "You've hit your session limit",
          resultJson: { summary },
        }, now)).toEqual(defaultBackoff);
      }
    });

    it("ignores a quoted clock in the result when only the generic quota text is in the own error", () => {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "Usage limit reached",
        resultJson: { stdout: "docs say: try again at 9:00 AM (UTC)" },
      }, now)).toEqual(defaultBackoff);
    });

    it("still uses the own error's clock when the result quotes a different one", () => {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)",
        resultJson: { summary: "Quoted: resets 9:00am (UTC) and try again at 4 AM (UTC)" },
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date("2026-10-13T19:40:00.000Z"),
        parsedResetTime: true,
      });
    });

    it("keeps the ACP error and stop reason as trusted clock sources and ignores the rest of the result", () => {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "acpx_turn_failed",
        error: "You've hit your session limit",
        resultJson: { summary: "Quoted: resets 9:00am (UTC)", stopReason: "end_turn" },
      }, now)).toEqual(defaultBackoff);
      expect(classifyAdapterFailureForRecovery({
        errorCode: "acpx_turn_failed",
        error: "Provider turn failed",
        resultJson: { stopReason: "You've hit your session limit - resets at 21:30 (UTC)" },
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date("2026-10-13T21:30:00.000Z"),
        parsedResetTime: true,
      });
    });

    it("validates each candidate before choosing, so an invalid earlier clock does not hide a valid later one", () => {
      for (const errorCode of ["adapter_failed", "acpx_turn_failed"]) {
        const error = (invalid: string) =>
          `You've hit your session limit · resets ${invalid} · or resets 10:40pm (Asia/Jerusalem)`;
        for (const invalid of ["25:99 (UTC)", "13pm (UTC)", "9:75 UTC", "8:00 (Not/AZone)"]) {
          expect(classifyAdapterFailureForRecovery({ errorCode, error: error(invalid), resultJson: {} }, now)).toEqual({
            kind: "provider_quota",
            retryAt: new Date("2026-10-13T19:40:00.000Z"),
            parsedResetTime: true,
          });
        }
      }
    });

    it("falls back to the default backoff when every candidate is invalid", () => {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "You've hit your session limit · resets 25:99 (UTC) · try again at 8:00 (Not/AZone)",
        resultJson: {},
      }, now)).toEqual(defaultBackoff);
    });

    it("keeps a later try-again clock for a generic usage limit when an earlier reset text is invalid", () => {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "You've hit your usage limit; resets 8 pigs. Try again at 10:40pm (Asia/Jerusalem).",
        resultJson: {},
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date("2026-10-13T19:40:00.000Z"),
        parsedResetTime: true,
      });
    });
  });

  it("takes the exact Claude statement from the ACP stop reason", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    for (const resultJson of [
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

  it("ignores ACP reset clocks that are far from the quota statement or lack a word boundary", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const far = `You've hit your session limit.${" x".repeat(100)} resets 10:40pm (Asia/Jerusalem)`;
    const glued = "You've hit your session limit. See presets 10:40pm for options";
    for (const error of [far, glued]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode: "acpx_turn_failed",
        error,
        resultJson: {},
      }, now)).toEqual({
        kind: "provider_quota",
        retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
        parsedResetTime: false,
      });
    }
  });

  it("keeps the whole timezone when the ACP clock ends at the window boundary", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const statement = "You've hit your session limit";
    const lead = " ".repeat(PROVIDER_QUOTA_WINDOW_FOR_TEST - "resets ".length - 1);
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: `${statement}${lead}resets 10:40pm (Asia/Jerusalem)`,
      resultJson: {},
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T19:40:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("ignores an unrelated 'resets' counter elsewhere in the ACP evidence", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const error = `Retry counter resets 8 times.${" x".repeat(100)} You've hit your session limit`;
    expect(classifyAdapterFailureForRecovery({ errorCode: "acpx_turn_failed", error, resultJson: {} }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("does not read unrelated 'resets N' prose as a clock on either path", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const fallback = {
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    };
    for (const errorCode of ["acpx_turn_failed", "adapter_failed"]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "You've hit your session limit; the cache resets 7 days ago and the counter resets 8 times",
        resultJson: {},
      }, now)).toEqual(fallback);
    }
  });

  it("keeps 'try again at' winning over earlier unrelated 'resets N' prose on non-ACP adapters", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: `The cache resets 7 days ago. ${"filler ".repeat(30)}You've hit your usage limit. Try again at 3:42 PM.`,
      resultJson: {},
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T15:42:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("retries now when the ACP reset clock elapsed moments ago instead of waiting a day", () => {
    const now = new Date("2026-10-13T19:40:20.000Z");
    for (const error of [
      "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)",
      "You've hit your session limit · resets 19:40 (UTC)",
    ]) {
      expect(classifyAdapterFailureForRecovery({ errorCode: "acpx_turn_failed", error, resultJson: {} }, now)).toEqual({
        kind: "provider_quota",
        retryAt: now,
        parsedResetTime: true,
      });
    }
  });

  it.each(["adapter_failed", "provider_quota"])(
    "retries now when a %s reset clock elapsed moments ago",
    (errorCode) => {
      const now = new Date("2026-10-13T19:40:20.000Z");
      for (const error of [
        "You've hit your session limit · resets 10:40pm (Asia/Jerusalem)",
        "You've hit your usage limit. Upgrade or try again at 19:40 (UTC).",
      ]) {
        expect(classifyAdapterFailureForRecovery({ errorCode, error, resultJson: {} }, now)).toEqual({
          kind: "provider_quota",
          retryAt: now,
          parsedResetTime: true,
        });
      }
    },
  );

  it("reads a reset clock that has a timezone but no minutes or meridiem", () => {
    const now = new Date("2026-10-13T05:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your session limit · resets 8 UTC",
      resultJson: {},
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T08:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("treats a reset that elapsed hours before recovery ran as due now, not tomorrow", () => {
    const failedAt = new Date("2026-10-13T19:00:00.000Z");
    const now = new Date("2026-10-13T20:11:00.000Z");
    for (const errorCode of ["acpx_turn_failed", "adapter_failed"]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "You've hit your session limit · resets 19:40 (UTC)",
        resultJson: {},
        finishedAt: failedAt,
      }, now)).toEqual({ kind: "provider_quota", retryAt: now, parsedResetTime: true });
    }
  });

  it("counts a reset exactly at the grace boundary before the failure as due now", () => {
    const failedAt = new Date("2026-10-13T19:00:00.000Z");
    const now = new Date("2026-10-13T19:10:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your session limit · resets 18:30 (UTC)",
      resultJson: {},
      finishedAt: failedAt,
    }, now)).toEqual({ kind: "provider_quota", retryAt: now, parsedResetTime: true });
  });

  it("still waits for a reset that is after the failure and not yet reached", () => {
    const failedAt = new Date("2026-10-13T19:00:00.000Z");
    const now = new Date("2026-10-13T19:05:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your session limit · resets 19:40 (UTC)",
      resultJson: {},
      startedAt: failedAt,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T19:40:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("still reads a reset clock that follows long upgrade text on non-ACP adapters", () => {
    const now = new Date("2026-10-13T18:00:38.000Z");
    const error = `You've hit your usage limit. Upgrade to Pro (https://example.test/upgrade), visit ${"settings ".repeat(30)}to purchase more credits or try again at 10:40pm (Asia/Jerusalem).`;
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: {},
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-13T19:40:00.000Z"),
      parsedResetTime: true,
    });
    const glued = "You've hit your session limit. See presets 10:40pm for options";
    expect(classifyAdapterFailureForRecovery({ errorCode: "adapter_failed", error: glued, resultJson: {} }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
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
