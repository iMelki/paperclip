import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCompanyCoordinationTasks = vi.hoisted(() => vi.fn());
const mockGetIssueCoordination = vi.hoisted(() => vi.fn());

vi.mock("../services/coordination.js", () => ({
  getCompanyCoordinationTasks: mockGetCompanyCoordinationTasks,
  getIssueCoordination: mockGetIssueCoordination,
}));

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { coordinationRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/coordination.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
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
    mockGetIssueCoordination.mockResolvedValue(null);

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
    mockGetIssueCoordination.mockResolvedValue(mockDetail);

    const app = await createApp();
    const res = await request(app).get("/api/issues/22222222-2222-4222-8222-222222222222/coordination");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockDetail);
  });
});
