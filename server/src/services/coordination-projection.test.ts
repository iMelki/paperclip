import { describe, expect, it } from "vitest";
import {
  projectTaskCoordinationView,
  type CoordinationProjectionSnapshot,
} from "./coordination-projection.js";

const OBSERVED_AT = new Date("2026-08-21T00:10:00.000Z");

function makeSnapshot(): CoordinationProjectionSnapshot {
  return {
    observedAt: new Date(OBSERVED_AT.getTime()),
    rootIssue: {
      id: "root-1",
      identifier: "iMelki/paperclip#82",
      issueNumber: 82,
      status: "in_progress",
      assigneeAgentId: "agent-lead",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:09:30.000Z"),
    },
    childIssues: [{
      id: "child-1",
      description: "Keep the company-scoped loader private.",
      status: "in_review",
      assigneeAgentId: "agent-worker",
    }],
    participations: [{
      id: "participation-1",
      agentInstanceId: "instance-1",
      runtime: "codex",
      role: "reviewer",
      mode: "review",
      enforcementMode: "enforce_mutations",
      runId: "run-1",
      sessionId: "session-1",
      currentAction: "reviewing",
      progressNote: "Projection is deterministic.",
      blocker: null,
      nextAction: "Run focused tests.",
      retryState: { attempt: 1 },
      startedAt: new Date("2026-08-21T00:05:00.000Z"),
      lastSeenAt: new Date("2026-08-21T00:09:50.000Z"),
      endedAt: null,
    }],
    leases: [
      {
        issueId: "child-1",
        status: "released",
        scopeRepositories: ["old-repo"],
        scopePaths: ["old-path"],
      },
      {
        issueId: "child-1",
        status: "active",
        scopeRepositories: ["paperclip"],
        scopePaths: ["server/src/services"],
      },
    ],
    intents: [
      {
        id: "intent-pending",
        status: "pending",
        intentType: "pause",
        targetWorkUnitId: "child-1",
        requestedBy: "operator",
        createdAt: new Date("2026-08-21T00:08:00.000Z"),
        receipt: null,
        executedAt: null,
      },
      {
        id: "intent-executed",
        status: "executed",
        intentType: "retry",
        targetWorkUnitId: "child-1",
        requestedBy: "operator",
        createdAt: new Date("2026-08-21T00:07:00.000Z"),
        receipt: { outcome: "accepted" },
        executedAt: new Date("2026-08-21T00:07:30.000Z"),
      },
      {
        id: "intent-failed",
        status: "failed",
        intentType: "cancel",
        targetWorkUnitId: null,
        requestedBy: "operator",
        createdAt: new Date("2026-08-21T00:06:00.000Z"),
        receipt: null,
        executedAt: null,
      },
    ],
    hosts: [{
      hostId: "host-1",
      hostname: "paperclip-host",
      os: "win32",
      runtime: "codex",
      reachableAddresses: ["127.0.0.1"],
      environment: "local",
    }],
  };
}

describe("projectTaskCoordinationView", () => {
  it("projects the complete legacy view from a fixed snapshot", () => {
    expect(projectTaskCoordinationView(makeSnapshot())).toEqual({
      schemaVersion: "task-coordination.v1",
      task: {
        canonicalKey: "github:iMelki/paperclip#82",
        githubProjectItemId: null,
        mckTaskId: null,
        paperclipParentIssueId: "root-1",
        correlationId: "root-1",
        status: "in_progress",
        accountableLead: "agent-lead",
        generation: 1,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:09:30.000Z",
      },
      workUnits: [{
        id: "child-1",
        paperclipChildIssueId: "child-1",
        githubChildIssueId: null,
        owner: "agent-worker",
        acceptanceCriteria: ["Keep the company-scoped loader private."],
        tests: [],
        mutationScope: {
          repositories: ["paperclip"],
          paths: ["server/src/services"],
        },
        state: "submitted",
      }],
      participants: [{
        id: "participation-1",
        runtime: "codex",
        role: "reviewer",
        mode: "review",
        enforcementMode: "enforce_mutations",
        runId: "run-1",
        sessionId: "session-1",
        currentAction: "reviewing",
        progressNote: "Projection is deterministic.",
        blocker: null,
        nextAction: "Run focused tests.",
        retryState: { attempt: 1 },
        startedAt: "2026-08-21T00:05:00.000Z",
        lastSeenAt: "2026-08-21T00:09:50.000Z",
        endedAt: null,
      }],
      placements: [{
        hostId: "host-1",
        hostname: "paperclip-host",
        os: "win32",
        runtime: "codex",
        reachableAddresses: ["127.0.0.1"],
        environment: "local",
        nativePath: "",
        runtimePath: "",
        worktreeIdentity: "",
        repository: "",
        branch: "dev",
        dirty: false,
      }],
      delivery: { commits: [], pullRequests: [] },
      health: {
        heartbeatAgeSeconds: 10,
        processEvidence: true,
        outputEvidence: true,
        status: "healthy",
        freshnessTimestamp: "2026-08-21T00:09:50.000Z",
        evidenceSource: "paperclip-db",
      },
      controls: {
        permittedIntents: ["pause", "cancel", "retry", "release", "reassign", "takeover"],
        pendingIntents: [{
          id: "intent-pending",
          intentType: "pause",
          targetWorkUnitId: "child-1",
          requestedBy: "operator",
          createdAt: "2026-08-21T00:08:00.000Z",
        }],
        completedReceipts: [{
          id: "intent-executed",
          intentType: "retry",
          receipt: { outcome: "accepted" },
          executedAt: "2026-08-21T00:07:30.000Z",
        }],
      },
      provenance: {
        sourceAuthority: "paperclip",
        observedAt: "2026-08-21T00:10:00.000Z",
        confidence: 1,
        reconciliationDrift: false,
        driftDetails: [],
      },
    });
  });

  it.each([
    ["todo", "open"],
    ["backlog", "open"],
    ["open", "open"],
    ["in_progress", "in_progress"],
    ["blocked", "blocked"],
    ["in_review", "under_review"],
    ["under_review", "under_review"],
    ["done", "completed"],
    ["completed", "completed"],
    ["cancelled", "cancelled"],
    ["closed", "cancelled"],
    ["unexpected", "open"],
  ])("preserves root status mapping for %s", (status, expected) => {
    const snapshot = makeSnapshot();
    snapshot.rootIssue.status = status;
    expect(projectTaskCoordinationView(snapshot).task.status).toBe(expected);
  });

  it.each([
    ["todo", "pending"],
    ["backlog", "pending"],
    ["open", "pending"],
    ["in_progress", "in_progress"],
    ["in_review", "submitted"],
    ["under_review", "submitted"],
    ["done", "approved"],
    ["completed", "approved"],
    ["cancelled", "failed"],
    ["blocked", "failed"],
    ["closed", "pending"],
    ["unexpected", "pending"],
  ])("preserves child status mapping for %s", (status, expected) => {
    const snapshot = makeSnapshot();
    snapshot.childIssues[0]!.status = status;
    expect(projectTaskCoordinationView(snapshot).workUnits[0]!.state).toBe(expected);
  });

  it.each([
    [300, "healthy"],
    [301, "stale"],
    [1800, "stale"],
    [1801, "orphaned"],
  ])("uses the root timestamp fallback at the %i-second health boundary", (age, expected) => {
    const snapshot = makeSnapshot();
    snapshot.participations = [];
    snapshot.rootIssue.updatedAt = new Date(snapshot.observedAt.getTime() - age * 1000);
    const health = projectTaskCoordinationView(snapshot).health;
    expect(health.heartbeatAgeSeconds).toBe(age);
    expect(health.status).toBe(expected);
    expect(health.freshnessTimestamp).toBe(snapshot.rootIssue.updatedAt.toISOString());
  });

  it("uses the most recent participant heartbeat", () => {
    const snapshot = makeSnapshot();
    snapshot.participations[0]!.lastSeenAt = new Date("2026-08-21T00:09:20.000Z");
    snapshot.participations.push({
      ...snapshot.participations[0]!,
      id: "participation-2",
      lastSeenAt: new Date("2026-08-21T00:09:55.000Z"),
    });

    const health = projectTaskCoordinationView(snapshot).health;
    expect(health.heartbeatAgeSeconds).toBe(5);
    expect(health.freshnessTimestamp).toBe("2026-08-21T00:09:55.000Z");
  });

  it("is deterministic and does not mutate its snapshot", () => {
    const snapshot = makeSnapshot();
    const before = JSON.stringify(snapshot);
    const first = projectTaskCoordinationView(snapshot);
    const second = projectTaskCoordinationView(snapshot);

    expect(second).toEqual(first);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});
