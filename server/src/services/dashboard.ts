import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { estimateTokenCostCents, toExclusiveTokenCounts } from "@paperclipai/shared";
import type { DashboardSpendBreakdownRow, DashboardSpendDay } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_SPEND_BREAKDOWN_LIMIT = 6;

type SpendAccumulator = { billedCents: number; estimatedCents: number; tokens: number; unpricedTokens: number };

// Billing states whose $0 ledger amount is a known non-charge for metered
// work (normalizeBilledCostCents books subscription runs at 0), so the tokens
// can be priced at API rates. Fixed, credits, unknown and metered rows keep
// their ledger amount; when the ledger marks them `unpriced` their tokens are
// reported as unpriced usage instead of being estimated.
const ESTIMABLE_BILLING_TYPES: ReadonlySet<string> = new Set(["subscription_included"]);

function topSpendRows(
  rows: Map<string, SpendAccumulator & { label: string }>,
): DashboardSpendBreakdownRow[] {
  return Array.from(rows.entries())
    .map(([key, row]) => ({ key, ...row }))
    .filter((row) => row.billedCents > 0 || row.estimatedCents > 0 || row.tokens > 0)
    .sort(
      (a, b) =>
        b.billedCents + b.estimatedCents - (a.billedCents + a.estimatedCents) || b.tokens - a.tokens,
    )
    .slice(0, DASHBOARD_SPEND_BREAKDOWN_LIMIT);
}

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), visibleIssueCondition()))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      // One grouped read feeds the month tile, the 14-day spend chart and the
      // agent/model breakdowns. Subscription rows (booked at costCents = 0,
      // see normalizeBilledCostCents) are priced here at API list rates as a
      // clearly separate estimate; nothing is written back, so budgets keep
      // enforcing billed cents only. Grouping by adapter type lets token counts
      // be normalized per producer (Codex input includes cache reads).
      const spendWindowStart = runActivityStart < monthStart ? runActivityStart : monthStart;
      const spendRows = await db
        .select({
          date: sql<string>`to_char(${costEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          agentId: costEvents.agentId,
          agentName: agents.name,
          adapterType: agents.adapterType,
          model: costEvents.model,
          billingType: costEvents.billingType,
          costStatus: costEvents.costStatus,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(agents.id, costEvents.agentId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, spendWindowStart)))
        .groupBy(
          sql`to_char(${costEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          costEvents.agentId,
          agents.name,
          agents.adapterType,
          costEvents.model,
          costEvents.billingType,
          costEvents.costStatus,
        );

      const monthStartKey = formatUtcDateKey(monthStart);
      const spendDays = new Map<string, DashboardSpendDay>(
        runActivityDays.map((date) => [
          date,
          { date, billedCents: 0, estimatedCents: 0, tokens: 0, unpricedTokens: 0 },
        ]),
      );
      const byAgent = new Map<string, SpendAccumulator & { label: string }>();
      const byModel = new Map<string, SpendAccumulator & { label: string }>();
      let monthSpendCents = 0;
      let monthEstimatedCents = 0;
      let monthEstimatedTokens = 0;
      let monthInputTokens = 0;
      let monthCachedInputTokens = 0;
      let monthOutputTokens = 0;
      let monthUnpricedTokens = 0;
      for (const row of spendRows) {
        const date = String(row.date);
        const billedCents = Number(row.costCents);
        const usage = toExclusiveTokenCounts(row.adapterType, {
          inputTokens: Number(row.inputTokens),
          cachedInputTokens: Number(row.cachedInputTokens),
          outputTokens: Number(row.outputTokens),
        });
        const tokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
        let estimatedCents = 0;
        let unpricedTokens = 0;
        if (ESTIMABLE_BILLING_TYPES.has(row.billingType) && billedCents === 0) {
          const estimate = estimateTokenCostCents(row.model, usage);
          if (estimate === null) unpricedTokens = tokens;
          else estimatedCents = estimate;
        } else if (row.costStatus === "unpriced" && billedCents === 0) {
          unpricedTokens = tokens;
        }

        const day = spendDays.get(date);
        if (day) {
          day.billedCents += billedCents;
          day.estimatedCents += estimatedCents;
          day.tokens += tokens;
          day.unpricedTokens += unpricedTokens;
        }
        if (date < monthStartKey) continue;

        monthSpendCents += billedCents;
        monthEstimatedCents += estimatedCents;
        if (estimatedCents > 0) monthEstimatedTokens += tokens;
        monthInputTokens += usage.inputTokens;
        monthCachedInputTokens += usage.cachedInputTokens;
        monthOutputTokens += usage.outputTokens;
        monthUnpricedTokens += unpricedTokens;
        for (const [map, key, label] of [
          [byAgent, row.agentId, row.agentName ?? "Unknown agent"],
          [byModel, row.model, row.model],
        ] as const) {
          const entry = map.get(key) ?? { label, billedCents: 0, estimatedCents: 0, tokens: 0, unpricedTokens: 0 };
          entry.billedCents += billedCents;
          entry.estimatedCents += estimatedCents;
          entry.tokens += tokens;
          entry.unpricedTokens += unpricedTokens;
          map.set(key, entry);
        }
      }
      // Per-day run breakdown. A run is "recovered" when its retry chain later
      // succeeded (recovered_runs = all ancestors of a succeeded retry), so a
      // restart-killed run whose retry succeeded is pulled out of the headline
      // failed count. error_code is carried through so a failure spike can be
      // attributed to an error class (e.g. process_lost, provider_quota).
      // Both recursive arms are bounded to the chart window: a retry is always
      // created after the run it retries, so ancestors of an out-of-window
      // child are themselves out of window and invisible to the membership
      // test below. Unbounded, the seed walks every run the company ever had.
      const runActivityRows = (await db.execute(sql`
        WITH RECURSIVE recovered_runs(id) AS (
          SELECT parent.id
          FROM ${heartbeatRuns} AS child
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
          WHERE child.company_id = ${companyId}
            AND child.status = 'succeeded'
            AND child.created_at >= ${runActivityStart.toISOString()}::timestamptz
          UNION
          SELECT parent.id
          FROM recovered_runs rr
          JOIN ${heartbeatRuns} AS child ON child.id = rr.id
          JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
          WHERE child.created_at >= ${runActivityStart.toISOString()}::timestamptz
        )
        SELECT
          to_char(run.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          run.status AS status,
          run.error_code AS error_code,
          (run.id IN (SELECT id FROM recovered_runs)) AS recovered,
          count(*)::double precision AS count
        FROM ${heartbeatRuns} AS run
        WHERE run.company_id = ${companyId}
          AND run.created_at >= ${runActivityStart.toISOString()}::timestamptz
        GROUP BY date, run.status, run.error_code, recovered
      `)) as unknown as Iterable<{
        date: string;
        status: string;
        error_code: string | null;
        recovered: boolean | string;
        count: number | string;
      }>;

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          {
            date,
            succeeded: 0,
            failed: 0,
            recovered: 0,
            other: 0,
            total: 0,
            failedByErrorCode: {} as Record<string, number>,
          },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(String(row.date));
        if (!bucket) continue;
        const count = Number(row.count);
        const status = String(row.status);
        // Postgres booleans can arrive as JS boolean or "t"/"true" depending on driver.
        const recovered = row.recovered === true || row.recovered === "t" || row.recovered === "true";
        if (status === "succeeded") {
          bucket.succeeded += count;
        } else if (status === "failed" || status === "timed_out") {
          if (recovered) {
            bucket.recovered += count;
          } else {
            bucket.failed += count;
            const code =
              typeof row.error_code === "string" && row.error_code.length > 0
                ? row.error_code
                : "unknown";
            bucket.failedByErrorCode[code] = (bucket.failedByErrorCode[code] ?? 0) + count;
          }
        } else {
          bucket.other += count;
        }
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
          monthInputTokens,
          monthCachedInputTokens,
          monthOutputTokens,
          monthEstimatedCents,
          monthEstimatedTokens,
          monthUnpricedTokens,
          spendDays: Array.from(spendDays.values()),
          byAgent: topSpendRows(byAgent),
          byModel: topSpendRows(byModel),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
