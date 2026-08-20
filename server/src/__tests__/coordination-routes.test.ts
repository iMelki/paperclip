import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCompanyCoordinationTasks = vi.hoisted(() => vi.fn());
const mockGetIssueCoordination = vi.hoisted(() => vi.fn());
const mockGetIssueCoordinationRootScope = vi.hoisted(() => vi.fn());

vi.mock("../services/coordination.js", () => ({
  getCompanyCoordinationTasks: mockGetCompanyCoordinationTasks,
  getIssueCoordination: mockGetIssueCoordination,
  getIssueCoordinationRootScope: mockGetIssueCoordinationRootScope,
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

describe("coordination routes", () => {
  beforeEach(() => {
    mockGetCompanyCoordinationTasks.mockReset();
    mockGetIssueCoordination.mockReset();
    mockGetIssueCoordinationRootScope.mockReset();
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
    expect(res.body).toEqual(mockTasks);
    expect(mockGetCompanyCoordinationTasks).toHaveBeenCalledWith(expect.anything(), "company-1");
  });

  it("returns 404 when root issue is not found for GET /api/issues/:rootIssueId/coordination", async () => {
    mockGetIssueCoordinationRootScope.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(404);
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
    mockGetIssueCoordinationRootScope.mockResolvedValue({ companyId: "company-1" });
    mockGetIssueCoordination.mockResolvedValue(mockDetail);

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

  it("returns detail for an agent from the root company", async () => {
    mockGetIssueCoordinationRootScope.mockResolvedValue({ companyId: "company-1" });
    mockGetIssueCoordination.mockResolvedValue({ allowed: true });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
    expect(mockGetIssueCoordination).toHaveBeenCalledWith(
      expect.anything(),
      "22222222-2222-4222-8222-222222222222",
      "company-1",
    );
  });

  it("rejects anonymous callers before looking up coordination scope or detail", async () => {
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(401);
    expect(mockGetIssueCoordinationRootScope).not.toHaveBeenCalled();
    expect(mockGetIssueCoordination).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "foreign board actor",
      actor: {
        type: "board",
        userId: "user-2",
        companyIds: ["company-2"],
        source: "session",
        isInstanceAdmin: false,
      },
    },
    {
      label: "foreign agent actor",
      actor: {
        type: "agent",
        agentId: "agent-2",
        companyId: "company-2",
        source: "agent_key",
      },
    },
  ])("returns the same 404 for a $label without loading detail", async ({ actor }) => {
    mockGetIssueCoordinationRootScope.mockResolvedValue({ companyId: "company-1" });
    const app = await createApp(actor);

    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Root issue not found" });
    expect(mockGetIssueCoordination).not.toHaveBeenCalled();
  });
});
