import type { DashboardSummary } from "@paperclipai/shared";
import { formatCents, formatTokens } from "./utils";

/**
 * Cents for display. Estimates arrive as fractional cents, so a real but
 * sub-cent amount shows as "<$0.01" instead of rounding to "$0.00".
 */
export function formatSpendCents(cents: number): string {
  return cents > 0 && cents < 1 ? "<$0.01" : formatCents(cents);
}

/**
 * Month Spend tile content. Subscription-billed runs book $0 in the cost
 * ledger, so when the dashboard reports an API-price estimate for their tokens
 * the tile adds it, marks the figure with "~" and "(est.)", and says how much
 * of it was actually billed. The estimate is never presented as a charge, and
 * tokens with neither a billed amount nor a known rate are named separately.
 */
export function monthSpendTile(costs: DashboardSummary["costs"]): {
  value: string;
  label: string;
  description: string;
} {
  const billed = costs.monthSpendCents;
  const estimated = costs.monthEstimatedCents ?? 0;
  const estimatedTokens = costs.monthEstimatedTokens ?? 0;
  const unpricedTokens = costs.monthUnpricedTokens ?? 0;
  const unpriced = unpricedTokens > 0 ? `${formatTokens(unpricedTokens)} tokens unpriced` : null;

  if (estimated <= 0) {
    const budget =
      costs.monthBudgetCents > 0
        ? `${costs.monthUtilizationPercent}% of ${formatCents(costs.monthBudgetCents)} budget`
        : "No budget set";
    return {
      value: formatCents(billed),
      label: "Month Spend",
      description: unpriced ? `${budget}; ${unpriced}` : budget,
    };
  }

  const description =
    `${formatCents(billed)} billed + ~${formatSpendCents(estimated)} at API prices ` +
    `for ${formatTokens(estimatedTokens)} tokens`;
  return {
    value: `~${formatSpendCents(billed + estimated)}`,
    label: "Month Spend (est.)",
    description: unpriced ? `${description}; ${unpriced}` : description,
  };
}
