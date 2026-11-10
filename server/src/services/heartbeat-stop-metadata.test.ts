import { afterAll, describe, expect, it } from "vitest";
import { ADAPTER_DEFAULT_TIMEOUT_SEC } from "@paperclipai/adapter-utils/adapter-timeout";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  const previousEnv = process.env.PAPERCLIP_ADAPTER_TIMEOUT_SEC;
  delete process.env.PAPERCLIP_ADAPTER_TIMEOUT_SEC;
  afterAll(() => {
    if (previousEnv === undefined) delete process.env.PAPERCLIP_ADAPTER_TIMEOUT_SEC;
    else process.env.PAPERCLIP_ADAPTER_TIMEOUT_SEC = previousEnv;
  });

  it("uses a non-zero default when timeoutSec is missing, 0, or negative", () => {
    const cases: Array<[string, number]> = [
      ["codex_local", ADAPTER_DEFAULT_TIMEOUT_SEC.codex_local],
      ["claude_local", ADAPTER_DEFAULT_TIMEOUT_SEC.claude_local],
      ["cursor", ADAPTER_DEFAULT_TIMEOUT_SEC.cursor],
      ["gemini_local", ADAPTER_DEFAULT_TIMEOUT_SEC.gemini_local],
      ["opencode_local", ADAPTER_DEFAULT_TIMEOUT_SEC.opencode_local],
      ["pi_local", ADAPTER_DEFAULT_TIMEOUT_SEC.pi_local],
      ["process", ADAPTER_DEFAULT_TIMEOUT_SEC.process],
      ["hermes_local", ADAPTER_DEFAULT_TIMEOUT_SEC.hermes_local],
      ["hermes_gateway", ADAPTER_DEFAULT_TIMEOUT_SEC.hermes_gateway],
      ["openclaw_gateway", ADAPTER_DEFAULT_TIMEOUT_SEC.openclaw_gateway],
      ["cursor_cloud", ADAPTER_DEFAULT_TIMEOUT_SEC.cursor_cloud],
      ["paperclip_runner", ADAPTER_DEFAULT_TIMEOUT_SEC.paperclip_runner],
    ];
    for (const [adapterType, timeoutSec] of cases) {
      for (const adapterConfig of [{}, { timeoutSec: 0 }, { timeoutSec: -1 }]) {
        expect(resolveHeartbeatRunTimeoutPolicy(adapterType, adapterConfig)).toEqual({
          effectiveTimeoutSec: timeoutSec,
          timeoutConfigured: false,
          timeoutSource: "default",
        });
      }
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: false,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
