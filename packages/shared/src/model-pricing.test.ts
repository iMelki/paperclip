import { describe, expect, it } from "vitest";
import {
  MODEL_PRICING,
  estimateTokenCostCents,
  normalizePricingModelId,
  resolveModelTokenRate,
  toExclusiveTokenCounts,
} from "./model-pricing.js";

const M = 1_000_000;

describe("normalizePricingModelId", () => {
  it("strips provider, region and context-window decorations", () => {
    expect(normalizePricingModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(normalizePricingModelId("us.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizePricingModelId("anthropic/claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(normalizePricingModelId("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(normalizePricingModelId(" GPT-5-Codex ")).toBe("gpt-5-codex");
    expect(normalizePricingModelId("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5-20250929");
  });
});

describe("resolveModelTokenRate", () => {
  it("prices listed ids and their dated snapshots", () => {
    expect(resolveModelTokenRate("claude-opus-4-1-20250805")).toEqual(MODEL_PRICING.rates["claude-opus-4-1"]);
    expect(resolveModelTokenRate("claude-opus-4-20250514")).toEqual(MODEL_PRICING.rates["claude-opus-4"]);
    expect(resolveModelTokenRate("claude-opus-4-8")).toEqual(MODEL_PRICING.rates["claude-opus-4-8"]);
    expect(resolveModelTokenRate("claude-sonnet-4-5-20250929")).toEqual(MODEL_PRICING.rates["claude-sonnet-4-5"]);
    expect(resolveModelTokenRate("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual(
      MODEL_PRICING.rates["claude-sonnet-4-5"],
    );
    expect(resolveModelTokenRate("gpt-5.1-codex")).toEqual(MODEL_PRICING.rates["gpt-5.1-codex"]);
  });

  it("leaves unlisted point releases and variants unpriced", () => {
    expect(resolveModelTokenRate("gpt-5.1.999")).toBeNull();
    expect(resolveModelTokenRate("gpt-5.1-codex-max")).toBeNull();
    expect(resolveModelTokenRate("claude-opus-4-99")).toBeNull();
    expect(resolveModelTokenRate("claude-sonnet-4-7")).toBeNull();
    expect(resolveModelTokenRate("claude-haiku-4-5-preview")).toBeNull();
  });

  it("prices Claude Code aliases at the current generation", () => {
    expect(resolveModelTokenRate("opus")).toEqual(MODEL_PRICING.rates.opus);
    expect(resolveModelTokenRate("sonnet[1m]")).toEqual(MODEL_PRICING.rates.sonnet);
  });

  it("matches bare gpt-5 exactly so later point releases stay unpriced", () => {
    expect(resolveModelTokenRate("gpt-5")?.input).toBe(1.25);
    expect(resolveModelTokenRate("gpt-5-2025-08-07")?.input).toBe(1.25);
    expect(resolveModelTokenRate("gpt-5.5")).toBeNull();
  });

  it("does not guess for unknown or missing models", () => {
    expect(resolveModelTokenRate("unknown")).toBeNull();
    expect(resolveModelTokenRate("")).toBeNull();
    expect(resolveModelTokenRate("llama-3")).toBeNull();
    expect(resolveModelTokenRate("claude-opus-40")).toBeNull();
  });
});

describe("estimateTokenCostCents", () => {
  it("prices input, cache reads and output separately", () => {
    expect(
      estimateTokenCostCents("claude-sonnet-4-6", { inputTokens: M, cachedInputTokens: M, outputTokens: M }),
    ).toBeCloseTo((3 + 0.3 + 15) * 100, 6);
  });

  it("keeps fractional cents so small runs add up", () => {
    expect(
      estimateTokenCostCents("claude-haiku-4-5", { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0 }),
    ).toBeCloseTo(0.1, 6);
  });

  it("returns 0 without usage and null for an unpriced model", () => {
    expect(estimateTokenCostCents("unknown", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(estimateTokenCostCents("unknown", { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("prices a Codex row with inclusive input once normalized", () => {
    // 1M input of which 900k cached: 100k fresh at $1.25 + 900k at $0.125.
    const usage = toExclusiveTokenCounts("codex_local", { inputTokens: M, cachedInputTokens: 900_000, outputTokens: 0 });
    expect(usage).toEqual({ inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 0 });
    expect(estimateTokenCostCents("gpt-5", usage)).toBeCloseTo(23.75, 6);
  });

  it("treats negative counts as zero", () => {
    expect(
      estimateTokenCostCents("claude-opus-5-5", { inputTokens: -10, cachedInputTokens: -10, outputTokens: M }),
    ).toBeCloseTo(2000, 6);
  });
});

describe("toExclusiveTokenCounts", () => {
  it("subtracts cache only for producers whose input includes it", () => {
    const usage = { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 7 };
    expect(toExclusiveTokenCounts("codex_local", usage)).toEqual({ inputTokens: 600, cachedInputTokens: 400, outputTokens: 7 });
    expect(toExclusiveTokenCounts("claude_local", usage)).toEqual(usage);
    expect(toExclusiveTokenCounts(null, usage)).toEqual(usage);
  });

  it("never goes negative on inconsistent inclusive rows", () => {
    expect(toExclusiveTokenCounts("codex_local", { inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 }).inputTokens).toBe(0);
  });
});
