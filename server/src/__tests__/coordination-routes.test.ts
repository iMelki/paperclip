import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCoordinationView } from "../services/coordination.js";

const mockGetCompanyCoordinationTasks = vi.hoisted(() => vi.fn());
const mockGetIssueCoordination = vi.hoisted(() => vi.fn());
const mockGetIssueCoordinationScope = vi.hoisted(() => vi.fn());

vi.mock("../services/coordination.js", () => ({
  COMPANY_COORDINATION_TASKS_DEFAULT_LIMIT: 50,
  COMPANY_COORDINATION_TASKS_MAX_LIMIT: 100,
  COMPANY_COORDINATION_TASKS_MAX_OFFSET: 10_000,
  getCompanyCoordinationTasks: mockGetCompanyCoordinationTasks,
  getIssueCoordination: mockGetIssueCoordination,
  getIssueCoordinationScope: mockGetIssueCoordinationScope,
}));

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  vi.resetModules();
  const [{ errorHandler }, { coordinationRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/coordination.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", coordinationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeCoordinationView(
  overrides: Partial<TaskCoordinationView> = {},
): TaskCoordinationView {
  return {
    schemaVersion: "task-coordination.v1",
    task: {
      canonicalKey: "github:iMelki/paperclip#28",
      githubProjectItemId: null,
      mckTaskId: null,
      paperclipParentIssueId: "55555555-5555-4555-8555-555555555555",
      correlationId: "55555555-5555-4555-8555-555555555555",
      status: "in_progress",
      accountableLead: "agent-worker",
      generation: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    },
    workUnits: [],
    participants: [],
    placements: [],
    delivery: { commits: [], pullRequests: [] },
    health: {
      heartbeatAgeSeconds: 10,
      status: "healthy",
      freshnessTimestamp: "2026-08-03T00:00:00.000Z",
      evidenceSource: "paperclip-task-participations",
    },
    controls: { permittedIntents: [], pendingIntents: [], completedReceipts: [] },
    provenance: {
      sourceAuthority: "paperclip",
      observedAt: "2026-08-03T00:00:00.000Z",
      confidence: 1,
      reconciliationDrift: false,
    },
    ...overrides,
  };
}

describe("coordination routes", () => {
  beforeEach(() => {
    mockGetCompanyCoordinationTasks.mockReset();
    mockGetIssueCoordination.mockReset();
    mockGetIssueCoordinationScope.mockReset();
  });

  it("returns task coordination array for GET /api/companies/:companyId/coordination/tasks", async () => {
    const mockTasks = [
      {
        schemaVersion: "task-coordination.v1",
        task: {
          canonicalKey: "github:paperclip/issue#100",
          githubProjectItemId: null,
          mckTaskId: null,
          paperclipParentIssueId: "11111111-1111-4111-8111-111111111111",
          correlationId: "11111111-1111-4111-8111-111111111111",
          status: "in_progress",
          accountableLead: "agent-1",
          generation: 1,
          createdAt: "2026-08-02T22:00:00.000Z",
          updatedAt: "2026-08-02T22:00:00.000Z",
        },
        workUnits: [],
        participants: [],
        placements: [],
        delivery: { commits: [], pullRequests: [] },
        health: {
          heartbeatAgeSeconds: 10,
          status: "healthy",
          freshnessTimestamp: "2026-08-02T22:00:00.000Z",
          evidenceSource: "paperclip-db",
        },
        controls: { permittedIntents: ["pause"], pendingIntents: [], completedReceipts: [] },
        provenance: {
          sourceAuthority: "paperclip",
          observedAt: "2026-08-02T22:00:00.000Z",
          confidence: 1,
          reconciliationDrift: false,
        },
      },
    ];
    mockGetCompanyCoordinationTasks.mockResolvedValue(mockTasks);

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/coordination/tasks");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual(mockTasks);
    expect(mockGetCompanyCoordinationTasks).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      { limit: 50, offset: 0 },
    );
  });

  it("forwards an explicit bounded company coordination page", async () => {
    mockGetCompanyCoordinationTasks.mockResolvedValue([]);

    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/coordination/tasks?limit=100&offset=7");

    expect(res.status).toBe(200);
    expect(mockGetCompanyCoordinationTasks).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      { limit: 100, offset: 7 },
    );
  });

  it.each([
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=1.5",
    "limit=abc",
    "offset=-1",
    "offset=1.5",
    "offset=abc",
    "offset=10001",
    "limit=1&limit=2",
  ])("rejects invalid company coordination pagination: %s", async (query) => {
    const app = await createApp();
    const res = await request(app)
      .get(`/api/companies/company-1/coordination/tasks?${query}`);

    expect(res.status).toBe(400);
    expect(mockGetCompanyCoordinationTasks).not.toHaveBeenCalled();
  });

  it("returns 404 when root issue is not found for GET /api/issues/:rootIssueId/coordination", async () => {
    mockGetIssueCoordinationScope.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ error: "Root issue not found" });
  });

  it("returns detail view when root issue exists for GET /api/issues/:rootIssueId/coordination", async () => {
    const mockDetail = {
      schemaVersion: "task-coordination.v1",
      task: {
        canonicalKey: "github:paperclip/issue#200",
        githubProjectItemId: null,
        mckTaskId: null,
        paperclipParentIssueId: "22222222-2222-4222-8222-222222222222",
        correlationId: "22222222-2222-4222-8222-222222222222",
        status: "open",
        accountableLead: "unassigned",
        generation: 1,
        createdAt: "2026-08-02T22:00:00.000Z",
        updatedAt: "2026-08-02T22:00:00.000Z",
      },
      workUnits: [],
      participants: [],
      placements: [],
      delivery: { commits: [], pullRequests: [] },
      health: {
        heartbeatAgeSeconds: 0,
        status: "healthy",
        freshnessTimestamp: "2026-08-02T22:00:00.000Z",
        evidenceSource: "paperclip-db",
      },
      controls: { permittedIntents: ["pause"], pendingIntents: [], completedReceipts: [] },
      provenance: {
        sourceAuthority: "paperclip",
        observedAt: "2026-08-02T22:00:00.000Z",
        confidence: 1,
        reconciliationDrift: false,
      },
    };
    mockGetIssueCoordinationScope.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
    });
    mockGetIssueCoordination.mockResolvedValue({ companyId: "company-1", view: mockDetail });

    const app = await createApp();
    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockDetail);
    expect(mockGetIssueCoordination).toHaveBeenCalledWith(
      expect.anything(),
      "22222222-2222-4222-8222-222222222222",
      "company-1",
    );
  });

  it("returns the same 404 for a root issue in another company without leaking coordination details", async () => {
    mockGetIssueCoordinationScope.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await request(app).get("/api/issues/33333333-3333-4333-8333-333333333333/coordination");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Root issue not found" });
    expect(mockGetIssueCoordination).not.toHaveBeenCalled();
  });

  it("fails closed if the issue company changes between authorization and detail loading", async () => {
    mockGetIssueCoordinationScope.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
    });
    mockGetIssueCoordination.mockResolvedValue({
      companyId: "company-2",
      view: { secret: "must-not-be-returned" },
    });

    const app = await createApp();
    const res = await request(app).get("/api/issues/44444444-4444-4444-8444-444444444444/coordination");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Root issue not found" });
    expect(res.text).not.toContain("must-not-be-returned");
  });

  it("redacts exact placement fields from the company collection for agent viewers", async () => {
    const viewWithUnexpectedFields = {
      ...makeCoordinationView({
        placements: [{
          hostId: "host-alias-1",
          hostname: "private-workstation",
          os: "windows",
          runtime: "codex",
          reachableAddresses: ["10.0.0.9"],
          nativePath: "C:\\private\\worktree",
          runtimePath: "/mnt/c/private/worktree",
          repository: "iMelki/paperclip",
          branch: "dev",
          dirty: true,
          processId: 1234,
          logReferences: ["C:\\private\\run.log"],
        }],
      }),
      futureTopLevelSecret: "future-secret-must-not-leak",
    };
    mockGetCompanyCoordinationTasks.mockResolvedValue([viewWithUnexpectedFields]);

    const app = await createApp({
      type: "agent",
      agentId: "agent-viewer",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app).get("/api/companies/company-1/coordination/tasks");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body[0].placements).toEqual([]);
    expect(res.text).not.toContain("host-alias-1");
    expect(res.text).not.toContain("private-workstation");
    expect(res.text).not.toContain("10.0.0.9");
    expect(res.text).not.toContain("C:\\\\private\\\\worktree");
    expect(res.text).not.toContain("C:\\\\private\\\\run.log");
    expect(res.text).not.toContain("future-secret-must-not-leak");
  });

  it("returns exact placement only to an assigned or participating agent on the issue endpoint", async () => {
    const exactPlacement = {
      hostId: "host-alias-1",
      hostname: "private-workstation",
      os: "windows",
      runtime: "codex",
      reachableAddresses: ["10.0.0.9"],
      nativePath: "C:\\private\\worktree",
      repository: "iMelki/paperclip",
      branch: "dev",
      dirty: true,
      processId: 1234,
    };
    mockGetIssueCoordinationScope.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
    });
    const detailView = makeCoordinationView({
      workUnits: [{
        id: "work-1",
        paperclipChildIssueId: "work-1",
        githubChildIssueId: null,
        owner: "agent-worker",
        acceptanceCriteria: [],
        tests: [],
        mutationScope: { repositories: ["iMelki/paperclip"], paths: ["C:\\private\\mutation-scope"] },
        state: "in_progress",
      }],
      participants: [{
        id: "participant-1",
        runtime: "codex-desktop",
        role: "worker",
        mode: "mutate",
        enforcementMode: "observe",
        retryState: { privatePath: "C:\\private\\retry-state" },
        runId: "private-run-id",
        sessionId: "private-session-id",
        currentAction: "read C:\\private\\action",
        progressNote: "private-progress",
        blocker: "private-blocker",
        nextAction: "private-next-action",
        startedAt: "2026-08-03T00:00:00.000Z",
        lastSeenAt: "2026-08-03T00:00:00.000Z",
        endedAt: null,
      }],
      placements: [exactPlacement],
      delivery: {
        commits: [],
        pullRequests: [{
          number: 1,
          url: "https://github.com/iMelki/paperclip/pull/1",
          headBranch: "dev",
          baseBranch: "main",
          status: "open",
          checks: [{ privatePath: "C:\\private\\check" }],
          receipt: { privatePath: "C:\\private\\pr-receipt" },
        }],
      },
      controls: {
        permittedIntents: [],
        pendingIntents: [],
        completedReceipts: [{
          id: "intent-1",
          intentType: "pause",
          executedAt: "2026-08-03T00:00:00.000Z",
          receipt: { privatePath: "C:\\private\\intent-receipt" },
        }],
      },
    });
    const detailViewWithUnexpectedFields = {
      ...detailView,
      task: { ...detailView.task, futureNestedSecret: "future-nested-secret-must-not-leak" },
      workUnits: detailView.workUnits.map((workUnit) => ({
        ...workUnit,
        futureNestedSecret: "future-nested-secret-must-not-leak",
      })),
      participants: detailView.participants.map((participant) => ({
        ...participant,
        futureNestedSecret: "future-nested-secret-must-not-leak",
      })),
      placements: detailView.placements.map((placement) => ({
        ...placement,
        futureNestedSecret: "future-nested-secret-must-not-leak",
      })),
      delivery: {
        ...detailView.delivery,
        futureNestedSecret: "future-nested-secret-must-not-leak",
        pullRequests: detailView.delivery.pullRequests.map((pullRequest) => ({
          ...pullRequest,
          futureNestedSecret: "future-nested-secret-must-not-leak",
        })),
      },
      health: { ...detailView.health, futureNestedSecret: "future-nested-secret-must-not-leak" },
      controls: { ...detailView.controls, futureNestedSecret: "future-nested-secret-must-not-leak" },
      provenance: { ...detailView.provenance, futureNestedSecret: "future-nested-secret-must-not-leak" },
    };
    mockGetIssueCoordination.mockResolvedValue({
      companyId: "company-1",
      placementViewerAgentIds: ["agent-worker"],
      view: detailViewWithUnexpectedFields,
    });

    const assignedApp = await createApp({
      type: "agent",
      agentId: "agent-worker",
      companyId: "company-1",
      source: "agent_key",
    });
    const assigned = await request(assignedApp)
      .get("/api/issues/55555555-5555-4555-8555-555555555555/coordination");
    expect(assigned.status).toBe(200);
    expect(assigned.headers["cache-control"]).toBe("no-store");
    expect(assigned.body.placements[0]).toEqual(exactPlacement);
    expect(assigned.body.workUnits[0].mutationScope.paths).toEqual(["C:\\private\\mutation-scope"]);
    expect(assigned.body.participants[0].retryState).toEqual({ privatePath: "C:\\private\\retry-state" });
    expect(assigned.text).not.toContain("future-nested-secret-must-not-leak");

    const endedParticipantApp = await createApp({
      type: "agent",
      agentId: "agent-ended",
      companyId: "company-1",
      source: "agent_key",
    });
    const observer = await request(endedParticipantApp)
      .get("/api/issues/55555555-5555-4555-8555-555555555555/coordination");
    expect(observer.status).toBe(200);
    expect(observer.headers["cache-control"]).toBe("no-store");
    expect(observer.body.placements).toEqual([]);
    expect(observer.text).not.toContain("host-alias-1");
    expect(observer.text).not.toContain("private-workstation");
    expect(observer.text).not.toContain("10.0.0.9");
    expect(observer.text).not.toContain("C:\\\\private\\\\worktree");
    expect(observer.body.workUnits[0].mutationScope.paths).toEqual([]);
    expect(observer.body.participants[0]).toMatchObject({
      runId: null,
      sessionId: null,
      currentAction: null,
      progressNote: null,
      blocker: null,
      nextAction: null,
      retryState: null,
    });
    expect(observer.body.delivery.pullRequests[0].checks).toBeUndefined();
    expect(observer.body.delivery.pullRequests[0].receipt).toBeUndefined();
    expect(observer.body.controls.completedReceipts[0]).toEqual({
      id: "intent-1",
      intentType: "pause",
      executedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(observer.text).not.toContain("C:\\\\private\\\\mutation-scope");
    expect(observer.text).not.toContain("C:\\\\private\\\\retry-state");
    expect(observer.text).not.toContain("C:\\\\private\\\\intent-receipt");
    expect(observer.text).not.toContain("future-nested-secret-must-not-leak");
  });
});
