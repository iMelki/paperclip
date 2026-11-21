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
function stubHermes(options: {
  record?: string | null; exportExitCode?: number; exportTimedOut?: boolean; noSessionId?: boolean; chatOutput?: string;
} = {}) {
  const record = options.record === undefined ? exportRecord() : options.record;
  vi.mocked(serverUtils.runChildProcess).mockImplementation((async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("sessions")) {
      if (record !== null) await fs.writeFile(args[args.length - 1], `${record}\n`, "utf8");
      return { exitCode: options.exportExitCode ?? 0, signal: null, timedOut: options.exportTimedOut === true, stdout: "", stderr: "" };
    }
    const body = options.chatOutput ?? "Done.\n";
    const stdout = options.noSessionId ? body : `${body}\nsession_id: ${SESSION}\n`;
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

  const SCRAPED = "cost: $0\ntokens: 12 input 3 output\n";

  it("output saying cost $0 does not override an export whose cost is unknown", async () => {
    stubHermes({ record: exportRecord({ model: "auto", estimated_cost_usd: 0, cost_status: "unknown" }), chatOutput: SCRAPED });
    const result = await execute(makeCtx().ctx as never);
    expect(result.costUsd ?? null).toBeNull();
    expect(result.resultJson).toMatchObject({ cost_usd: null });
    expect(result.usage?.inputTokens).toBe(1000);
  });

  it("output-derived numbers are not used when the export fails: usage and cost stay unknown", async () => {
    stubHermes({ exportExitCode: 1, chatOutput: SCRAPED });
    const result = await execute(makeCtx().ctx as never);
    expect(result.usage).toBeUndefined();
    expect(result.costUsd ?? null).toBeNull();
    expect(result.resultJson).toMatchObject({ usage_status: "unknown", usage: null, cost_usd: null });
  });

  it("a record with a missing counter is unknown, not zero, and keeps the earlier baseline", async () => {
    const baseline = { sessionId: SESSION, inputTokens: 600, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    stubHermes({ record: exportRecord({ input_tokens: undefined }), chatOutput: SCRAPED });
    const result = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(result.usage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ usage_status: "unknown", usage_unavailable_reason: "record_incomplete" });
    expect(result.sessionParams).toMatchObject({ usageBaseline: baseline });
  });

  it("a record with an invalid estimated cost reports tokens but no cost", async () => {
    stubHermes({ record: exportRecord({ estimated_cost_usd: "" }) });
    const result = await execute(makeCtx().ctx as never);
    expect(result.usage?.inputTokens).toBe(1000);
    expect(result.costUsd ?? null).toBeNull();
  });

  it("a stored baseline with a missing counter makes the run unknown but keeps the valid watermarks and recovers them", async () => {
    // Prior input watermark is invalid; output 40 and cached 100 are valid and were already accounted.
    const baseline = { sessionId: SESSION, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    stubHermes({ record: exportRecord({ output_tokens: 100 }) });
    const unknown = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(unknown.usage).toBeUndefined();
    expect(unknown.resultJson).toMatchObject({ usage_unavailable_reason: "baseline_unusable" });
    // Valid watermarks are not replaced by this run's totals: output stays 40, cached stays 100.
    expect(unknown.sessionParams).toMatchObject({
      usageBaseline: { sessionId: SESSION, inputTokens: 1000, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.05 },
    });
    // Recovery: a later reading reports what the unknown run saw (100 - 40), not only the 10 since then.
    stubHermes({ record: exportRecord({ input_tokens: 1050, output_tokens: 110 }) });
    const next = await execute(makeCtx(unknown.sessionParams as Record<string, unknown>).ctx as never);
    expect(next.usage).toEqual({ inputTokens: 50, outputTokens: 70, cachedInputTokens: 300 });
    expect(next.resultJson).toMatchObject({ usage_status: "reported" });
  });

  it("cost known -> unknown -> known: an unknown cost keeps the watermark, so the outstanding cost is reported", async () => {
    const baseline = { sessionId: SESSION, inputTokens: 600, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    // Tokens are known but Hermes cannot price this reading: no cost reported, watermark 0.02 kept.
    stubHermes({ record: exportRecord({ estimated_cost_usd: 0, cost_status: "unknown" }) });
    const unpriced = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(unpriced.usage).toEqual({ inputTokens: 400, outputTokens: 60, cachedInputTokens: 300 });
    expect(unpriced.costUsd ?? null).toBeNull();
    expect(unpriced.sessionParams).toMatchObject({ usageBaseline: { inputTokens: 1000, costUsd: 0.02 } });
    // A valid cumulative 0.05 now reports the full outstanding 0.03.
    stubHermes({ record: exportRecord({ input_tokens: 1100, estimated_cost_usd: 0.05 }) });
    const priced = await execute(makeCtx(unpriced.sessionParams as Record<string, unknown>).ctx as never);
    expect(priced.costUsd).toBeCloseTo(0.03, 10);
    expect(priced.sessionParams).toMatchObject({ usageBaseline: { costUsd: 0.05 } });
  });

  it("an unknown run (unusable baseline) also keeps the valid cost watermark", async () => {
    const baseline = { sessionId: SESSION, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 };
    stubHermes({ record: exportRecord({ estimated_cost_usd: 0, cost_status: "unknown" }) });
    const unknown = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(unknown.sessionParams).toMatchObject({ usageBaseline: { costUsd: 0.02 } });
  });

  it("a counter that went down is unknown and the higher watermark survives to the next run", async () => {
    const baseline = { sessionId: SESSION, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, costUsd: 0.05 };
    stubHermes({ record: exportRecord({ input_tokens: 900 }) });
    const dropped = await execute(makeCtx({ sessionId: SESSION, usageBaseline: baseline }).ctx as never);
    expect(dropped.usage).toBeUndefined();
    expect(dropped.resultJson).toMatchObject({ usage_unavailable_reason: "counter_regressed" });
    expect(dropped.sessionParams).toMatchObject({ usageBaseline: baseline });
    stubHermes({ record: exportRecord({ input_tokens: 1100 }) });
    const next = await execute(makeCtx(dropped.sessionParams as Record<string, unknown>).ctx as never);
    expect(next.usage?.inputTokens).toBe(100);
  });

  it("end to end over three runs: 1000, then 900 (unknown), then 1100 reports 100 above the kept watermark", async () => {
    stubHermes({ record: exportRecord({ input_tokens: 1000 }) });
    const first = await execute(makeCtx().ctx as never);
    expect(first.usage?.inputTokens).toBe(1000);
    expect(first.sessionParams).toMatchObject({ usageBaseline: { inputTokens: 1000 } });
    stubHermes({ record: exportRecord({ input_tokens: 900 }) });
    const second = await execute(makeCtx(first.sessionParams as Record<string, unknown>).ctx as never);
    expect(second.usage).toBeUndefined();
    expect(second.resultJson).toMatchObject({ usage_status: "unknown", usage_unavailable_reason: "counter_regressed", usage: null });
    expect(second.sessionParams).toMatchObject({ usageBaseline: { inputTokens: 1000 } });
    stubHermes({ record: exportRecord({ input_tokens: 1100 }) });
    const third = await execute(makeCtx(second.sessionParams as Record<string, unknown>).ctx as never);
    expect(third.usage?.inputTokens).toBe(100);
    expect(third.resultJson).toMatchObject({ usage_status: "reported" });
  });
});
