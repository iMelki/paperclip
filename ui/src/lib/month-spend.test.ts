import type { DashboardSummary } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { formatSpendCents, monthSpendTile } from "./month-spend";

function costs(overrides: Partial<DashboardSummary["costs"]> = {}): DashboardSummary["costs"] {
  return {
    monthSpendCents: 0,
    monthBudgetCents: 0,
    monthUtilizationPercent: 0,
    monthInputTokens: 0,
    monthCachedInputTokens: 0,
    monthOutputTokens: 0,
    monthEstimatedCents: 0,
    monthEstimatedTokens: 0,
    monthUnpricedTokens: 0,
    spendDays: [],
    byAgent: [],
    byModel: [],
    ...overrides,
  };
}

describe("monthSpendTile", () => {
  it("shows billed spend and budget when nothing is estimated", () => {
    expect(monthSpendTile(costs({ monthSpendCents: 1234, monthBudgetCents: 10_000, monthUtilizationPercent: 12.34 }))).toEqual({
      value: "$12.34",
      label: "Month Spend",
      description: "12.34% of $100.00 budget",
    });
  });

  it("labels an estimate as one and separates billed from estimated", () => {
    const tile = monthSpendTile(
      costs({ monthEstimatedCents: 4_250, monthEstimatedTokens: 10_500_000 }),
    );
    expect(tile.value).toBe("~$42.50");
    expect(tile.label).toBe("Month Spend (est.)");
    expect(tile.description).toBe("$0.00 billed + ~$42.50 at API prices for 10.5M tokens");
  });

  it("adds billed and estimated spend in a mixed month", () => {
    const tile = monthSpendTile(costs({ monthSpendCents: 1_000, monthEstimatedCents: 500, monthEstimatedTokens: 2_000 }));
    expect(tile.value).toBe("~$15.00");
    expect(tile.description).toBe("$10.00 billed + ~$5.00 at API prices for 2.0k tokens");
  });

  it("shows a sub-cent estimate instead of rounding it away", () => {
    const tile = monthSpendTile(costs({ monthEstimatedCents: 0.1, monthEstimatedTokens: 1_000 }));
    expect(tile.value).toBe("~<$0.01");
    expect(tile.label).toBe("Month Spend (est.)");
    expect(tile.description).toBe("$0.00 billed + ~<$0.01 at API prices for 1.0k tokens");
  });

  it("names unpriced tokens on their own when nothing could be estimated", () => {
    const tile = monthSpendTile(costs({ monthUnpricedTokens: 2_500_000 }));
    expect(tile.value).toBe("$0.00");
    expect(tile.label).toBe("Month Spend");
    expect(tile.description).toBe("No budget set; 2.5M tokens unpriced");
  });

  it("keeps unpriced tokens visible next to an estimate", () => {
    const tile = monthSpendTile(costs({ monthEstimatedCents: 500, monthEstimatedTokens: 2_000, monthUnpricedTokens: 300 }));
    expect(tile.description).toBe("$0.00 billed + ~$5.00 at API prices for 2.0k tokens; 300 tokens unpriced");
  });

  it("does not call usage unpriced just because it was billed at $0", () => {
    expect(monthSpendTile(costs({ monthInputTokens: 5_000 })).description).toBe("No budget set");
  });
});

describe("formatSpendCents", () => {
  it("keeps sub-cent amounts visible", () => {
    expect(formatSpendCents(0)).toBe("$0.00");
    expect(formatSpendCents(0.1)).toBe("<$0.01");
    expect(formatSpendCents(1)).toBe("$0.01");
  });
});
