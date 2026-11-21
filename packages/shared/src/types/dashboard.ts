export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated in a failure state (failed/timed_out) but whose retry
   * chain eventually succeeded — e.g. restart-killed runs that recovered. Kept
   * out of `failed` so the headline failure count reflects true, unrecovered
   * failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
    /**
     * Token usage for the same UTC month. Subscription-billed runs book
     * `costCents = 0` (see normalizeBilledCostCents), so tokens are the only
     * signal of how much such a fleet consumed. Input is exclusive of cache
     * reads for every producer (see toExclusiveTokenCounts).
     */
    monthInputTokens: number;
    monthCachedInputTokens: number;
    monthOutputTokens: number;
    /**
     * API-equivalent cost of `subscription_included` events, priced from the
     * shared MODEL_PRICING table at read time. Fractional cents (round only
     * for display). An estimate: never stored, never counted against budgets.
     */
    monthEstimatedCents: number;
    /** Tokens covered by monthEstimatedCents. */
    monthEstimatedTokens: number;
    /**
     * Tokens with neither a billed amount nor an estimate: subscription usage
     * on a model with no known rate, or events the ledger marks `unpriced`.
     */
    monthUnpricedTokens: number;
    /** Billed and estimated spend per UTC day over the run-activity window. */
    spendDays: DashboardSpendDay[];
    /** This month's spend by agent, largest first (top entries only). */
    byAgent: DashboardSpendBreakdownRow[];
    /** This month's spend by model, largest first (top entries only). */
    byModel: DashboardSpendBreakdownRow[];
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

export interface DashboardSpendDay {
  date: string;
  /** Cents booked in the cost ledger (metered API billing). */
  billedCents: number;
  /** API-equivalent estimate for subscription usage (see monthEstimatedCents). */
  estimatedCents: number;
  tokens: number;
  /** Tokens with neither a billed amount nor an estimate (see monthUnpricedTokens). */
  unpricedTokens: number;
}

export interface DashboardSpendBreakdownRow {
  /** Agent id or model id, depending on the breakdown. */
  key: string;
  label: string;
  billedCents: number;
  estimatedCents: number;
  tokens: number;
  unpricedTokens: number;
}
