/**
 * hermes_local reports usage from Hermes' own session record.
 *
 * A chat run prints no token counts or cost, so the adapter used to report none and Paperclip budgets
 * could never trip. It now runs `hermes sessions export` for the run's session and reports the model
 * that answered, the billing provider, the tokens and a cost only when Hermes could price the model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: vi.fn() };
});

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const SESSION = "local-aaaa1111";

function exportRecord(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: SESSION, model: "anthropic/claude-haiku-5.5", billing_provider: "openrouter",
    input_tokens: 1000, output_tokens: 100, cache_read_tokens: 400,
    estimated_cost_usd: 0.05, actual_cost_usd: "", cost_status: "estimated", ...overrides,
  });
}

/** First call is the chat run; a call with `sessions` is the export, which writes its output file. */
function stubHermes(options: { record?: string | null; exportExitCode?: number; exportTimedOut?: boolean; noSessionId?: boolean } = {}) {
  const record = options.record === undefined ? exportRecord() : options.record;
  vi.mocked(serverUtils.runChildProcess).mockImplementation((async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("sessions")) {
      if (record !== null) await fs.writeFile(args[args.length - 1], `${record}\n`, "utf8");
      return { exitCode: options.exportExitCode ?? 0, signal: null, timedOut: options.exportTimedOut === true, stdout: "", stderr: "" };
    }
    const stdout = options.noSessionId ? "Done.\n" : `Done.\n\nsession_id: ${SESSION}\n`;
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
  }) as never);
}

function makeCtx(sessionParams: Record<string, unknown> | null = null) {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      runId: "run-1",
      authToken: "fixture-run-token",
      agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
      config: { command: process.execPath, model: "anthropic/claude-haiku-5.5", provider: "openrouter", timeoutSec: 60, graceSec: 5 },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
      onLog: vi.fn(async (_stream: string, chunk: string) => { logs.push(chunk); }),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    },
  };
}

describe("hermes_local usage reporting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the served model, billing provider, tokens and a priced cost", async () => {
    stubHermes();
    const { ctx } = makeCtx();
    const result = await execute(ctx as never);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBe(0.05);
    expect(result.billingType).toBe("metered_api");
    expect(result.biller).toBe("openrouter");
    expect(result.model).toBe("anthropic/claude-haiku-5.5");
    expect(result.resultJson).toMatchObject({ served_model: "anthropic/claude-haiku-5.5", cost_status: "estimated" });
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION, usageBaseline: { sessionId: SESSION, inputTokens: 1000, costUsd: 0.05 } });
  });

  it("reports tokens only, never a zero cost, when Hermes cannot price the model", async () => {
    stubHermes({ record: exportRecord({ model: "auto", estimated_cost_usd: 0, cost_status: "unknown" }) });
    const result = await execute(makeCtx().ctx as never);
    expect(result.usage?.inputTokens).toBe(1000);
    expect(result.costUsd ?? null).toBeNull();
    expect(result.billingType ?? null).toBeNull();
  });

  it("a resumed session reports only this run's share", async () => {
    stubHermes();
    const baseline = { sessionId: SESSION, inputTokens: 600, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    const result = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 60, cachedInputTokens: 300 });
    expect(result.costUsd).toBeCloseTo(0.03, 10);
  });

  it("a resumed session without a baseline is marked cumulative and carries no cost", async () => {
    stubHermes();
    const result = await execute(makeCtx({ sessionId: SESSION }).ctx as never);
    expect(result.usageBasis).toBe("session_cumulative");
    expect(result.costUsd ?? null).toBeNull();
  });

  it.each([
    ["the export fails", { exportExitCode: 1 }, "export_failed"],
    ["the export times out", { exportTimedOut: true, exportExitCode: 1 }, "export_timed_out"],
    ["the export writes nothing", { record: null }, "export_failed"],
    ["the export is not a session record", { record: "not json" }, "record_unreadable"],
    ["Hermes printed no session id", { noSessionId: true }, "no_session_id"],
  ])("when %s the run still succeeds, reports usage as unknown (not zero) and says why", async (_label, options, reason) => {
    stubHermes(options);
    const { ctx, logs } = makeCtx();
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    // Unknown, never zero: no usage and no cost object that a budget check could read as "free".
    expect(result.usage).toBeUndefined();
    expect(result.costUsd ?? null).toBeNull();
    expect(result.resultJson).toMatchObject({ usage_status: "unknown", usage_unavailable_reason: reason, usage: null });
    expect(logs.join("")).toContain("Usage unavailable");
  });

  it("a measured run says its usage is reported", async () => {
    stubHermes();
    const result = await execute(makeCtx().ctx as never);
    expect(result.resultJson).toMatchObject({ usage_status: "reported", usage_unavailable_reason: null });
  });

  it("after a failed read the previous baseline of the same session is kept, so the next read recovers the share", async () => {
    stubHermes({ exportExitCode: 1 });
    const baseline = { sessionId: SESSION, inputTokens: 600, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    const failed = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(failed.sessionParams).toMatchObject({ sessionId: SESSION, usageBaseline: baseline });
    // The next run reads the cumulative record against that older baseline: both runs' tokens appear.
    stubHermes();
    const next = await execute(makeCtx(failed.sessionParams as Record<string, unknown>).ctx as never);
    expect(next.usage).toEqual({ inputTokens: 400, outputTokens: 60, cachedInputTokens: 300 });
  });

  it("a baseline of another session is not carried over", async () => {
    stubHermes({ exportExitCode: 1 });
    const other = { sessionId: "local-other", inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.001 };
    const failed = await execute(makeCtx({ sessionId: "local-other", usageBaseline: other }).ctx as never);
    expect((failed.sessionParams as Record<string, unknown>).usageBaseline).toBeUndefined();
  });
});
