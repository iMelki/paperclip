import type { DashboardSummary } from "@paperclipai/shared";
import { formatCents, formatTokens } from "./utils";

/**
 * Month Spend tile content. Subscription-billed runs book $0 in the cost
 * ledger, so when the dashboard reports an API-price estimate for their tokens
 * the tile adds it, marks the figure with "~" and "(est.)", and says how much
 * of it was actually billed. The estimate is never presented as a charge.
 */
export function monthSpendTile(costs: DashboardSummary["costs"]): {
  value: string;
  label: string;
  description: string;
} {
  const billed = costs.monthSpendCents;
  const estimated = costs.monthEstimatedCents ?? 0;
  const tokens =
    (costs.monthInputTokens ?? 0) + (costs.monthCachedInputTokens ?? 0) + (costs.monthOutputTokens ?? 0);

  if (estimated <= 0) {
    const budget =
      costs.monthBudgetCents > 0
        ? `${costs.monthUtilizationPercent}% of ${formatCents(costs.monthBudgetCents)} budget`
        : "No budget set";
    return {
      value: formatCents(billed),
      label: "Month Spend",
      description: billed === 0 && tokens > 0 ? `${formatTokens(tokens)} tokens on models without a known price` : budget,
    };
  }

  return {
    value: `~${formatCents(billed + estimated)}`,
    label: "Month Spend (est.)",
    description:
      `${formatCents(billed)} billed + ~${formatCents(estimated)} at API prices ` +
      `for ${formatTokens(tokens)} tokens`,
  };
}
