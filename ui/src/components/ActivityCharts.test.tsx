// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunActivityChart, SpendBreakdownChart, SpendChart, SuccessRateChart } from "./ActivityCharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  flushSync(() => {
    root.render(ui);
  });
}

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    responsibleUserId: null,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-04-20T11:58:00.000Z"),
    finishedAt: new Date("2026-04-20T11:59:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date("2026-04-20T11:58:00.000Z"),
    updatedAt: new Date("2026-04-20T11:59:00.000Z"),
    ...overrides,
  };
}

describe("ActivityCharts", () => {
  it("renders empty run charts when dashboard aggregate data is temporarily missing", () => {
    render(<RunActivityChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");

    render(<SuccessRateChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");
  });

  it("still aggregates raw agent runs for detail charts", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({ id: "run-failed", status: "failed", errorCode: "provider_quota" }),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("No runs yet");
    // Tooltip now carries the per-day breakdown (incl. failure error codes).
    const dayCell = container.querySelector("[title^='2026-04-20: 2 runs']");
    expect(dayCell).not.toBeNull();
    expect(dayCell?.getAttribute("title")).toContain("provider_quota: 1");
  });

  it("renders a distinct recovered segment and legend for recovered restart kills", () => {
    render(
      <RunActivityChart
        activity={[
          {
            date: "2026-04-20",
            succeeded: 3,
            failed: 1,
            recovered: 4,
            other: 0,
            total: 8,
            failedByErrorCode: { process_lost: 1 },
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Recovered");
    const dayCell = container.querySelector("[title*='recovered: 4']");
    expect(dayCell).not.toBeNull();
  });

  it("stacks billed and estimated spend per day and labels the estimate", () => {
    render(
      <SpendChart
        days={[
          { date: "2026-04-19", billedCents: 0, estimatedCents: 0, tokens: 0, unpricedTokens: 0 },
          { date: "2026-04-20", billedCents: 250, estimatedCents: 1_200, tokens: 3_000_000, unpricedTokens: 0 },
        ]}
      />,
    );

    expect(container.textContent).toContain("Billed");
    expect(container.textContent).toContain("Estimated (API prices)");
    const dayCell = container.querySelector("[title^='2026-04-20']");
    expect(dayCell?.getAttribute("title")).toContain("estimated: ~$12.00 at API prices");
  });

  it("keeps token-only unpriced days visible as their own category", () => {
    render(
      <SpendChart
        days={[
          { date: "2026-04-19", billedCents: 0, estimatedCents: 0, tokens: 0, unpricedTokens: 0 },
          { date: "2026-04-20", billedCents: 0, estimatedCents: 0, tokens: 1_500_000, unpricedTokens: 1_500_000 },
        ]}
      />,
    );
    expect(container.textContent).not.toContain("No spend recorded");
    expect(container.textContent).toContain("Unpriced usage");
    expect(container.querySelector("[data-testid='spend-unpriced-strip'] [title='2026-04-20: 1.5M tokens unpriced']")).not.toBeNull();
    expect(container.querySelector("[title^='2026-04-20']")?.getAttribute("title")).toContain("unpriced: 1.5M tokens");
  });

  it("shows sub-cent estimates instead of $0.00", () => {
    render(<SpendChart days={[{ date: "2026-04-20", billedCents: 0, estimatedCents: 0.1, tokens: 1_000, unpricedTokens: 0 }]} />);
    expect(container.querySelector("[title^='2026-04-20']")?.getAttribute("title")).toContain("estimated: ~<$0.01");
    expect(container.querySelector("[data-testid='spend-unpriced-strip']")).toBeNull();
  });

  it("says when nothing was spent or used", () => {
    render(<SpendChart days={[{ date: "2026-04-20", billedCents: 0, estimatedCents: 0, tokens: 0, unpricedTokens: 0 }]} />);
    expect(container.textContent).toContain("No spend recorded");
  });

  it("ranks the spend breakdown and marks estimated totals", () => {
    render(
      <SpendBreakdownChart
        rows={[
          { key: "a", label: "CEO", billedCents: 0, estimatedCents: 900, tokens: 10, unpricedTokens: 0 },
          { key: "b", label: "Engineer", billedCents: 500, estimatedCents: 0, tokens: 10, unpricedTokens: 0 },
          { key: "c", label: "Researcher", billedCents: 0, estimatedCents: 0, tokens: 2_000, unpricedTokens: 2_000 },
        ]}
      />,
    );
    expect(container.textContent).toContain("~$9.00");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).not.toContain("~$5.00");
    expect(container.textContent).toContain("Researcher");
    expect(container.textContent).toContain("2.0k tok unpriced");
    expect(container.textContent).toContain("Unpriced usage");

    render(<SpendBreakdownChart rows={[]} />);
    expect(container.textContent).toContain("No spend this month");
  });
});
