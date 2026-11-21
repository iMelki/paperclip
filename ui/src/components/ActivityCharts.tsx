import type {
  DashboardRunActivityDay,
  DashboardSpendBreakdownRow,
  DashboardSpendDay,
  HeartbeatRun,
} from "@paperclipai/shared";
import { formatCents, formatTokens } from "../lib/utils";
import { formatSpendCents } from "../lib/month-spend";

/* ---- Utilities ---- */

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function emptyRunDay(date: string): DashboardRunActivityDay {
  return { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
}

const runSegmentColors = {
  succeeded: "var(--hex-10b981)",
  recovered: "var(--status-task-todo)",
  failed: "var(--hex-ef4444)",
  other: "var(--hex-737373)",
} as const;

// Compact per-day tooltip that also attributes failures to their error class.
function runDayTooltip(entry: DashboardRunActivityDay): string {
  const lines = [`${entry.date}: ${entry.total} run${entry.total === 1 ? "" : "s"}`];
  if (entry.succeeded > 0) lines.push(`  succeeded: ${entry.succeeded}`);
  if (entry.recovered > 0) lines.push(`  recovered: ${entry.recovered} (retry succeeded)`);
  if (entry.failed > 0) {
    lines.push(`  failed: ${entry.failed}`);
    const codes = Object.entries(entry.failedByErrorCode ?? {}).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of codes) lines.push(`    ${code}: ${count}`);
  }
  if (entry.other > 0) lines.push(`  other: ${entry.other}`);
  return lines.join("\n");
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-(--sz-3px) mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(i === 0 || i === 6 || i === 13) ? (
            <span className="text-(length:--text-nano) text-muted-foreground tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-(length:--text-nano) text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-3 overflow-hidden rounded-lg border border-border p-4">
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {subtitle && <span className="text-(length:--text-nano) text-muted-foreground/60">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

/* ---- Chart Components ---- */

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never };

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, emptyRunDay(day));
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") {
      entry.succeeded++;
    } else if (run.status === "failed" || run.status === "timed_out") {
      // A flat run list has no retry-chain linkage, so recovery can't be derived
      // here (the company dashboard computes it server-side). Attribute the
      // failure to its error class so the breakdown still renders.
      entry.failed++;
      const code = run.errorCode && run.errorCode.length > 0 ? run.errorCode : "unknown";
      entry.failedByErrorCode[code] = (entry.failedByErrorCode[code] ?? 0) + 1;
    } else {
      entry.other++;
    }
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const hasRecovered = activity.some(v => v.recovered > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  const legendItems = [
    { color: runSegmentColors.succeeded, label: "Succeeded" },
    ...(hasRecovered ? [{ color: runSegmentColors.recovered, label: "Recovered" }] : []),
    { color: runSegmentColors.failed, label: "Failed" },
    { color: runSegmentColors.other, label: "Other" },
  ];

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={runDayTooltip(entry)}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div style={{ flex: entry.succeeded, backgroundColor: runSegmentColors.succeeded }} />}
                  {entry.recovered > 0 && <div style={{ flex: entry.recovered, backgroundColor: runSegmentColors.recovered }} />}
                  {entry.failed > 0 && <div style={{ flex: entry.failed, backgroundColor: runSegmentColors.failed }} />}
                  {entry.other > 0 && <div style={{ flex: entry.other, backgroundColor: runSegmentColors.other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={legendItems} />
    </div>
  );
}

const priorityColors: Record<string, string> = {
  critical: "var(--hex-ef4444)",
  high: "var(--hex-f97316)",
  medium: "var(--hex-eab308)",
  low: "var(--hex-6b7280)",
};

const priorityOrder = ["critical", "high", "medium", "low"] as const;

export function PriorityChart({ issues }: { issues: { priority: string; createdAt: Date }[] }) {
  const days = getLast14Days();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, { critical: 0, high: 0, medium: 0, low: 0 });
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority in entry) entry[issue.priority]++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = Array.from(grouped.values()).some(v => Object.values(v).reduce((a, b) => a + b, 0) > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {priorityOrder.map(p => entry[p] > 0 ? (
                    <div key={p} style={{ flex: entry[p], backgroundColor: priorityColors[p] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
    </div>
  );
}

// DECISION-SHEET.md B5: chart status colors re-pointed at the canonical
// --status-task-* system (DESIGN.md principle 5 — an operator learns one
// status vocabulary; badge, row, chart, and log agree). Previously an
// independent palette (todo blue, in_progress violet, etc.). `backlog`
// deliberately keeps --project-none (pre-B5, per user ruling); the
// priority series and success-rate tints below are not status hues and
// are left alone.
const statusColors: Record<string, string> = {
  todo: "var(--status-task-todo)",
  in_progress: "var(--status-task-in_progress)",
  in_review: "var(--status-task-in_review)",
  done: "var(--status-task-done)",
  blocked: "var(--status-task-blocked)",
  cancelled: "var(--status-task-cancelled)",
  backlog: "var(--project-none)",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  backlog: "Backlog",
};

export function IssueStatusChart({ issues }: { issues: { status: string; createdAt: Date }[] }) {
  const days = getLast14Days();
  const allStatuses = new Set<string>();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, {});
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry[issue.status] = (entry[issue.status] ?? 0) + 1;
    allStatuses.add(issue.status);
  }

  const statusOrder = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"].filter(s => allStatuses.has(s));
  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = allStatuses.size > 0;

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {statusOrder.map(s => (entry[s] ?? 0) > 0 ? (
                    <div key={s} style={{ flex: entry[s], backgroundColor: statusColors[s] ?? "var(--hex-6b7280)" }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "var(--hex-6b7280)", label: statusLabels[s] ?? s }))} />
    </div>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          // Recovered runs ultimately succeeded, so they count toward the rate
          // rather than dragging it down as failures.
          const effectiveSucceeded = entry.succeeded + entry.recovered;
          const rate = entry.total > 0 ? effectiveSucceeded / entry.total : 0;
          const color = entry.total === 0 ? undefined : rate >= 0.8 ? "var(--hex-10b981)" : rate >= 0.5 ? "var(--hex-eab308)" : "var(--hex-ef4444)";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${effectiveSucceeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}

/* ---- Spend ---- */

// Billed = cents in the cost ledger. Estimated = API-list-price value of
// subscription token usage booked at $0; never a real charge. Unpriced = tokens
// with neither, shown as their own strip because they have no dollar height.
const spendSegmentColors = {
  billed: "var(--hex-10b981)",
  estimated: "var(--hex-6366f1)",
  unpriced: "var(--hex-64748b)",
} as const;

type SpendEntry = { billedCents: number; estimatedCents: number; tokens: number; unpricedTokens?: number };

function spendTooltip(label: string, entry: SpendEntry): string {
  const lines = [label];
  if (entry.billedCents > 0) lines.push(`  billed: ${formatCents(entry.billedCents)}`);
  if (entry.estimatedCents > 0) lines.push(`  estimated: ~${formatSpendCents(entry.estimatedCents)} at API prices`);
  if ((entry.unpricedTokens ?? 0) > 0) lines.push(`  unpriced: ${formatTokens(entry.unpricedTokens ?? 0)} tokens`);
  lines.push(`  tokens: ${formatTokens(entry.tokens)}`);
  return lines.join("\n");
}

function spendLegend(rows: readonly SpendEntry[]) {
  const hasBilled = rows.some((row) => row.billedCents > 0);
  const hasEstimated = rows.some((row) => row.estimatedCents > 0);
  const hasUnpriced = rows.some((row) => (row.unpricedTokens ?? 0) > 0);
  return [
    ...(hasBilled ? [{ color: spendSegmentColors.billed, label: "Billed" }] : []),
    ...(hasEstimated ? [{ color: spendSegmentColors.estimated, label: "Estimated (API prices)" }] : []),
    ...(hasUnpriced ? [{ color: spendSegmentColors.unpriced, label: "Unpriced usage" }] : []),
  ];
}

export function SpendChart({ days: spendDays }: { days?: DashboardSpendDay[] | null }) {
  const activity = spendDays ?? [];
  const hasSpend = activity.some((day) => day.billedCents > 0 || day.estimatedCents > 0);
  const hasUnpriced = activity.some((day) => (day.unpricedTokens ?? 0) > 0);
  if (!hasSpend && !hasUnpriced) return <p className="text-xs text-muted-foreground">No spend recorded</p>;
  const days = activity.map((day) => day.date);
  const maxValue = Math.max(...activity.map((day) => day.billedCents + day.estimatedCents), 1);

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {activity.map((entry) => {
          const total = entry.billedCents + entry.estimatedCents;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={entry.date} className="flex-1 h-full flex flex-col justify-end" title={spendTooltip(entry.date, entry)}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.billedCents > 0 && <div style={{ flex: entry.billedCents, backgroundColor: spendSegmentColors.billed }} />}
                  {entry.estimatedCents > 0 && <div style={{ flex: entry.estimatedCents, backgroundColor: spendSegmentColors.estimated }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      {hasUnpriced && (
        <div className="mt-px flex gap-(--sz-3px)" data-testid="spend-unpriced-strip">
          {activity.map((entry) => (
            <div
              key={entry.date}
              className="flex-1 h-1 rounded-sm"
              title={(entry.unpricedTokens ?? 0) > 0 ? `${entry.date}: ${formatTokens(entry.unpricedTokens)} tokens unpriced` : undefined}
              style={(entry.unpricedTokens ?? 0) > 0 ? { backgroundColor: spendSegmentColors.unpriced } : undefined}
            />
          ))}
        </div>
      )}
      <DateLabels days={days} />
      <ChartLegend items={spendLegend(activity)} />
    </div>
  );
}

export function SpendBreakdownChart({ rows, emptyLabel = "No spend this month" }: { rows?: DashboardSpendBreakdownRow[] | null; emptyLabel?: string }) {
  const entries = (rows ?? []).filter(
    (row) => row.billedCents > 0 || row.estimatedCents > 0 || (row.unpricedTokens ?? 0) > 0,
  );
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  const maxValue = Math.max(...entries.map((row) => row.billedCents + row.estimatedCents), 1);

  return (
    <div>
      <div className="space-y-1.5">
        {entries.map((row) => {
          const total = row.billedCents + row.estimatedCents;
          const unpriced = row.unpricedTokens ?? 0;
          const money = total === 0 ? null : row.estimatedCents === 0 ? formatCents(total) : `~${formatSpendCents(total)}`;
          const amount = [money, unpriced > 0 ? `${formatTokens(unpriced)} tok unpriced` : null].filter(Boolean).join(" + ");
          return (
            <div key={row.key} className="min-w-0" title={spendTooltip(row.label, row)}>
              <div className="flex items-baseline justify-between gap-2 text-(length:--text-nano)">
                <span className="truncate text-muted-foreground">{row.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{amount}</span>
              </div>
              <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-sm bg-muted/30">
                {total > 0 ? (
                  <div className="flex gap-px" style={{ width: `${(total / maxValue) * 100}%` }}>
                    {row.billedCents > 0 && <div style={{ flex: row.billedCents, backgroundColor: spendSegmentColors.billed }} />}
                    {row.estimatedCents > 0 && <div style={{ flex: row.estimatedCents, backgroundColor: spendSegmentColors.estimated }} />}
                  </div>
                ) : (
                  <div className="w-full" style={{ backgroundColor: spendSegmentColors.unpriced }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ChartLegend items={spendLegend(entries)} />
    </div>
  );
}
