import { describe, expect, it } from "vitest";
import {
  computeRunUsage,
  parseHermesSessionExport,
  readUsageBaseline,
  toUsageBaseline,
  type HermesSessionUsage,
  type HermesUsageBaseline,
} from "./usage.js";

const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: "local-aaaa", model: "anthropic/claude-haiku-5.5", billing_provider: "openrouter",
  input_tokens: 18916, output_tokens: 3, cache_read_tokens: 832, cache_write_tokens: 0,
  estimated_cost_usd: 0.0013837532, actual_cost_usd: "", cost_status: "estimated", ...overrides,
});

describe("parseHermesSessionExport", () => {
  it("reads model, provider, tokens and an estimated cost", () => {
    expect(parseHermesSessionExport(`${record()}\n`)).toEqual({
      sessionId: "local-aaaa", model: "anthropic/claude-haiku-5.5", provider: "openrouter",
      inputTokens: 18916, outputTokens: 3, cachedInputTokens: 832, costUsd: 0.0013837532, costStatus: "estimated",
    });
  });

  it("an unknown cost status gives tokens and no cost, never a zero cost", () => {
    const parsed = parseHermesSessionExport(record({ model: "auto", estimated_cost_usd: 0, cost_status: "unknown" }));
    expect(parsed?.costUsd).toBeNull();
    expect(parsed?.inputTokens).toBe(18916);
  });

  it("prefers the actual cost when the status says actual", () => {
    expect(parseHermesSessionExport(record({ cost_status: "actual", actual_cost_usd: 0.5 }))?.costUsd).toBe(0.5);
  });

  it.each([
    ["missing", {}], ["blank", { input_tokens: "" }], ["null", { input_tokens: null }],
    ["negative", { input_tokens: -5 }], ["not a number", { input_tokens: "lots" }],
  ])("a %s token counter is unknown, not zero", (_label, patch) => {
    const text = JSON.parse(record()) as Record<string, unknown>;
    delete text.input_tokens;
    const parsed = parseHermesSessionExport(JSON.stringify({ ...text, ...patch }));
    expect(parsed?.inputTokens).toBeNull();
    expect(parsed?.outputTokens).toBe(3);
  });

  it.each([
    ["estimated", { cost_status: "estimated", estimated_cost_usd: "" }],
    ["estimated", { cost_status: "estimated", estimated_cost_usd: null }],
    ["estimated", { cost_status: "estimated", estimated_cost_usd: "junk" }],
    ["actual", { cost_status: "actual", actual_cost_usd: null }],
    ["actual", { cost_status: "actual", actual_cost_usd: "junk" }],
  ])("a missing or invalid %s cost is unknown, not zero (%#)", (_label, patch) => {
    expect(parseHermesSessionExport(record(patch))?.costUsd).toBeNull();
  });

  it.each(["", "not json", "{broken", JSON.stringify({ model: "x" })])("returns null for unusable input %#", (text) => {
    expect(parseHermesSessionExport(text)).toBeNull();
  });
});

describe("computeRunUsage", () => {
  const current = (overrides: Partial<HermesSessionUsage> = {}): HermesSessionUsage => ({
    sessionId: "local-aaaa", model: "m", provider: "openrouter", inputTokens: 1000, outputTokens: 100,
    cachedInputTokens: 400, costUsd: 0.05, costStatus: "estimated", ...overrides,
  });

  it("a fresh session counts in full", () => {
    expect(computeRunUsage(current(), null, null)).toMatchObject({
      usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 }, usageBasis: "per_run", costUsd: 0.05,
    });
  });

  it("a resumed session reports only this run's share when the baseline matches", () => {
    const baseline = toUsageBaseline(current({ inputTokens: 600, outputTokens: 40, cachedInputTokens: 100, costUsd: 0.02 }));
    const run = computeRunUsage(current(), baseline, "local-aaaa");
    expect(run.usage).toEqual({ inputTokens: 400, outputTokens: 60, cachedInputTokens: 300 });
    expect(run.usageBasis).toBe("per_run");
    expect(run.costUsd).toBeCloseTo(0.03, 10);
  });

  it("a resumed session without a matching baseline reports cumulative tokens and no cost", () => {
    for (const baseline of [null, toUsageBaseline(current({ sessionId: "local-other" }))]) {
      const run = computeRunUsage(current(), baseline, "local-aaaa");
      expect(run.usageBasis).toBe("session_cumulative");
      expect(run.costUsd).toBeNull();
      expect(run.usage?.inputTokens).toBe(1000);
    }
  });

  it("a counter that went down is unknown, not zero, and keeps the higher baseline", () => {
    const baseline = toUsageBaseline(current({ inputTokens: 5000, costUsd: 9 }));
    const run = computeRunUsage(current(), baseline, "local-aaaa");
    expect(run.usage).toBeNull();
    expect(run.costUsd).toBeNull();
    expect(run.unknownReason).toBe("counter_regressed");
    expect(run.nextBaseline).toBeNull();
  });

  it("regression then recovery: 1000 -> 900 is unknown, then 1100 reports 100 above the kept watermark", () => {
    let stored: HermesUsageBaseline | null = toUsageBaseline(current({ inputTokens: 1000 }));
    const dropped = computeRunUsage(current({ inputTokens: 900 }), stored, "local-aaaa");
    expect(dropped.usage).toBeNull();
    stored = dropped.nextBaseline ?? stored;
    expect(stored.inputTokens).toBe(1000);
    const recovered = computeRunUsage(current({ inputTokens: 1100 }), stored, "local-aaaa");
    expect(recovered.usage?.inputTokens).toBe(100);
  });

  it("a baseline with missing counters makes the run unknown instead of subtracting zero", () => {
    const baseline = { ...toUsageBaseline(current()), inputTokens: null };
    const run = computeRunUsage(current(), baseline, "local-aaaa");
    expect(run.usage).toBeNull();
    expect(run.unknownReason).toBe("baseline_unusable");
  });

  it("a session record with a missing counter is unknown and does not overwrite the stored baseline", () => {
    const run = computeRunUsage(current({ outputTokens: null }), toUsageBaseline(current()), "local-aaaa");
    expect(run.usage).toBeNull();
    expect(run.unknownReason).toBe("record_incomplete");
    expect(run.nextBaseline).toBeNull();
  });

  it("a cost that went down is unknown for the run, tokens stay known and the higher cost is kept", () => {
    const baseline = toUsageBaseline(current({ inputTokens: 600, costUsd: 9 }));
    const run = computeRunUsage(current(), baseline, "local-aaaa");
    expect(run.usage?.inputTokens).toBe(400);
    expect(run.costUsd).toBeNull();
    expect(run.nextBaseline?.costUsd).toBe(9);
  });

  it("an unknown cost on either side gives no cost for the run", () => {
    const baseline = toUsageBaseline(current({ costUsd: null }));
    expect(computeRunUsage(current(), baseline, "local-aaaa").costUsd).toBeNull();
  });
});

describe("readUsageBaseline", () => {
  it("round-trips a baseline stored in the session parameters", () => {
    const baseline = toUsageBaseline({
      sessionId: "local-aaaa", model: null, provider: null, inputTokens: 1, outputTokens: 2, cachedInputTokens: 3,
      costUsd: 0.1, costStatus: "estimated",
    });
    expect(readUsageBaseline({ sessionId: "local-aaaa", usageBaseline: baseline })).toEqual(baseline);
  });

  it("a stored baseline with missing or invalid counters reads as unknown counters, not zero", () => {
    const stored = readUsageBaseline({ usageBaseline: { sessionId: "local-aaaa", inputTokens: 5, costUsd: "x" } });
    expect(stored).toEqual({
      sessionId: "local-aaaa", inputTokens: 5, outputTokens: null, cachedInputTokens: null, costUsd: null,
    });
  });

  it.each([null, undefined, {}, { usageBaseline: null }, { usageBaseline: { inputTokens: 1 } }])(
    "returns null when there is no usable baseline %#", (params) => {
      expect(readUsageBaseline(params)).toBeNull();
    });
});
