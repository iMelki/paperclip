import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  projectTaskCoordinationViewV2,
  TASK_COORDINATION_V2_SCHEMA_SHA256,
} from "./coordination-v2.js";
import type { CoordinationProjectionSnapshot } from "./coordination-projection.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function snapshot(overrides: Partial<CoordinationProjectionSnapshot> = {}): CoordinationProjectionSnapshot {
  return {
    observedAt: NOW,
    rootIssue: {
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "paperclip/issue#53",
      issueNumber: 53,
      status: "in_progress",
      assigneeAgentId: "agent-lead",
      coordinationGeneration: 2,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-06T11:59:00.000Z"),
    },
    childIssues: [],
    participations: [{
      id: "22222222-2222-4222-8222-222222222222",
      agentInstanceId: "33333333-3333-4333-8333-333333333333",
      agentId: "agent-lead",
      runtime: "codex",
      role: "lead",
      mode: "mutate",
      enforcementMode: "observe",
      runId: "run-1",
      sessionId: "session-1",
      currentAction: null,
      progressNote: null,
      blocker: null,
      nextAction: null,
      retryState: null,
      startedAt: new Date("2026-09-06T11:00:00.000Z"),
      lastSeenAt: new Date("2026-09-06T11:59:40.000Z"),
      endedAt: null,
    }],
    leases: [],
    intents: [],
    hosts: [{
      hostId: "host-1",
      hostname: "paperclip-host",
      os: "windows",
      runtime: "native",
      reachableAddresses: ["127.0.0.1"],
      environment: "local",
    }],
    ...overrides,
  };
}

describe("task coordination v2", () => {
  it("pins the exact canonical schema bytes", () => {
    const bytes = readFileSync(new URL("../contracts/task-coordination.v2.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(TASK_COORDINATION_V2_SCHEMA_SHA256);
  });

  it("never fabricates identity, health, controls, or process evidence", () => {
    const view = projectTaskCoordinationViewV2(snapshot());
    expect(view.task.canonicalKey).toBeNull();
    expect(view.task.paperclipParentIssueId).toBe("11111111-1111-4111-8111-111111111111");
    expect(view.task.generation).toBe(2);
    expect(view.health.status).toBe("reporting_degraded");
    expect(view.health.processEvidence).toBe(false);
    expect(view.health.outputEvidence).toBe(false);
    expect(view.controls).toEqual({ permittedIntents: [], pendingIntents: [], completedReceipts: [] });
    expect(view.provenance.confidence).toBe(0);
    expect(view.provenance.reconciliationDrift).toBe(true);
  });

  it("hides host placement from an unrelated same-company agent", () => {
    expect(projectTaskCoordinationViewV2(snapshot(), "other-agent").placements).toEqual([]);
    expect(projectTaskCoordinationViewV2(snapshot(), "agent-lead").placements).toHaveLength(1);
  });

  it("fails closed for malformed persisted participant enums", () => {
    const malformed = snapshot({
      participations: [{ ...snapshot().participations[0], mode: "unexpected" }],
    });
    const view = projectTaskCoordinationViewV2(malformed);
    expect(view.participants).toEqual([]);
    expect(view.health.status).toBe("error");
    expect(view.health.processEvidence).toBe(false);
    expect(view.provenance.driftDetails.join(" ")).toMatch(/failed runtime evidence validation/i);
  });

  it("keeps stale, orphaned, future, and contradictory evidence non-positive", () => {
    const stale = projectTaskCoordinationViewV2(snapshot({
      participations: [{
        ...snapshot().participations[0],
        lastSeenAt: new Date(NOW.getTime() - 901_000),
      }],
    }));
    expect(stale.health.status).toBe("stale");
    expect(stale.health.heartbeatAgeSeconds).toBe(901);
    expect(stale.health.processEvidence).toBe(false);
    expect(stale.health.outputEvidence).toBe(false);

    const orphaned = projectTaskCoordinationViewV2(snapshot({
      participations: [{
        ...snapshot().participations[0],
        lastSeenAt: new Date(NOW.getTime() - 1_801_000),
      }],
    }));
    expect(orphaned.health.status).toBe("orphaned");
    expect(orphaned.health.heartbeatAgeSeconds).toBe(1801);

    const future = projectTaskCoordinationViewV2(snapshot({
      participations: [{
        ...snapshot().participations[0],
        lastSeenAt: new Date(NOW.getTime() + 1_000),
      }],
    }));
    expect(future.health.status).toBe("error");
    expect(future.health.heartbeatAgeSeconds).toBeNull();
    expect(future.health.processEvidence).toBe(false);

    const contradictory = projectTaskCoordinationViewV2(snapshot({
      participations: [{
        ...snapshot().participations[0],
        startedAt: new Date(NOW.getTime() - 10_000),
        lastSeenAt: new Date(NOW.getTime() - 20_000),
      }],
    }));
    expect(contradictory.participants).toEqual([]);
    expect(contradictory.health.status).toBe("error");
    expect(contradictory.provenance.confidence).toBe(0);
  });

  it("rejects a missing or non-positive persisted generation", () => {
    expect(() => projectTaskCoordinationViewV2(snapshot({
      rootIssue: { ...snapshot().rootIssue, coordinationGeneration: 0 },
    }))).toThrow(/coordination_generation must be a positive persisted integer/);
  });
});
