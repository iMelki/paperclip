import type { DashboardSummary } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { monthSpendTile } from "./month-spend";

function costs(overrides: Partial<DashboardSummary["costs"]> = {}): DashboardSummary["costs"] {
  return {
    monthSpendCents: 0,
    monthBudgetCents: 0,
    monthUtilizationPercent: 0,
    monthInputTokens: 0,
    monthCachedInputTokens: 0,
    monthOutputTokens: 0,
    monthEstimatedCents: 0,
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
      costs({ monthEstimatedCents: 4_250, monthInputTokens: 1_000_000, monthCachedInputTokens: 9_000_000, monthOutputTokens: 500_000 }),
    );
    expect(tile.value).toBe("~$42.50");
    expect(tile.label).toBe("Month Spend (est.)");
    expect(tile.description).toBe("$0.00 billed + ~$42.50 at API prices for 10.5M tokens");
  });

  it("adds billed and estimated spend in a mixed month", () => {
    const tile = monthSpendTile(costs({ monthSpendCents: 1_000, monthEstimatedCents: 500, monthOutputTokens: 2_000 }));
    expect(tile.value).toBe("~$15.00");
    expect(tile.description).toBe("$10.00 billed + ~$5.00 at API prices for 2.0k tokens");
  });

  it("says tokens are unpriced instead of implying nothing ran", () => {
    expect(monthSpendTile(costs({ monthInputTokens: 2_500_000 })).description).toBe(
      "2.5M tokens on models without a known price",
    );
  });
});
