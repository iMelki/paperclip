import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { getIssueCoordination } from "./coordination.js";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const ROOT_ISSUE_ID = "11111111-1111-4111-8111-111111111111";

function rootIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOT_ISSUE_ID,
    identifier: "paperclip/issue#53",
    issueNumber: 53,
    status: "in_progress",
    assigneeAgentId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

function activeParticipation(lastSeenAt: Date) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    runtime: "codex",
    role: "worker",
    mode: "mutate",
    enforcementMode: "observe",
    runId: "run-1",
    sessionId: "session-1",
    currentAction: null,
    progressNote: null,
    blocker: null,
    nextAction: null,
    retryState: null,
    startedAt: new Date("2026-08-12T11:00:00.000Z"),
    lastSeenAt,
    endedAt: null,
  };
}

function readOnlyDb(rows: unknown[]): Db {
  const queuedRows = [...rows];
  const where = vi.fn(() => Promise.resolve(queuedRows.shift()));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) } as unknown as Db;
}

async function readCoordination(
  participations: unknown[] = [],
  intents: unknown[] = [],
  issue = rootIssue(),
) {
  const db = readOnlyDb([[issue], [], participations, [], intents]);
  const view = await getIssueCoordination(db, ROOT_ISSUE_ID);
  expect(view).not.toBeNull();
  return view!;
}

describe("coordination evidence truthfulness", () => {
  it("does not turn a recently edited root issue into a healthy heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const view = await readCoordination();

    expect(view.health).toEqual({
      heartbeatAgeSeconds: null,
      processEvidence: false,
      outputEvidence: false,
      status: "offline",
      freshnessTimestamp: null,
      evidenceSource: "paperclip-db:no-active-participation-record",
    });
    expect(view.controls.permittedIntents).toEqual([]);
    expect(view.provenance).toMatchObject({
      confidence: 0,
      reconciliationDrift: true,
    });
    expect(view.provenance.driftDetails).toContain("No active persisted coordination participation is available.");

    vi.useRealTimers();
  });

  it("reports a fresh participation as reporting-only and keeps control authority empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const receipt = { outcome: "accepted" };

    const view = await readCoordination(
      [activeParticipation(new Date("2026-08-12T11:59:40.000Z"))],
      [{
        id: "33333333-3333-4333-8333-333333333333",
        status: "executed",
        intentType: "retry",
        receipt,
        executedAt: new Date("2026-08-12T11:59:45.000Z"),
      }],
    );

    expect(view.health).toEqual({
      heartbeatAgeSeconds: 20,
      processEvidence: false,
      outputEvidence: false,
      status: "reporting_degraded",
      freshnessTimestamp: "2026-08-12T11:59:40.000Z",
      evidenceSource: "paperclip-db:participation-heartbeat-only",
    });
    expect(view.controls.permittedIntents).toEqual([]);
    expect(view.controls.completedReceipts).toEqual([{
      id: "33333333-3333-4333-8333-333333333333",
      intentType: "retry",
      receipt,
      executedAt: "2026-08-12T11:59:45.000Z",
    }]);
    expect(view.placements).toEqual([]);
    expect(view.provenance).toMatchObject({
      confidence: 0,
      reconciliationDrift: true,
    });

    vi.useRealTimers();
  });

  it("fails closed when an active participation heartbeat is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const view = await readCoordination([
      activeParticipation(new Date("2026-08-12T11:54:59.000Z")),
    ]);

    expect(view.health).toMatchObject({
      heartbeatAgeSeconds: 301,
      processEvidence: false,
      outputEvidence: false,
      status: "stale",
    });
    expect(view.provenance).toMatchObject({
      confidence: 0,
      reconciliationDrift: true,
    });

    vi.useRealTimers();
  });

  it("fails closed when the persisted heartbeat is inconsistent with the read time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const view = await readCoordination([
      activeParticipation(new Date("2026-08-12T12:00:01.000Z")),
    ]);

    expect(view.health).toEqual({
      heartbeatAgeSeconds: null,
      processEvidence: false,
      outputEvidence: false,
      status: "error",
      freshnessTimestamp: "2026-08-12T12:00:01.000Z",
      evidenceSource: "paperclip-db:future-participation-heartbeat",
    });
    expect(view.provenance).toMatchObject({
      confidence: 0,
      reconciliationDrift: true,
    });

    vi.useRealTimers();
  });
});
