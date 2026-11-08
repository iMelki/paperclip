import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyA = "22222222-2222-4222-8222-222222222222";

function adminActor() {
  return {
    type: "board",
    userId: "admin-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyA],
  };
}

function memberActor() {
  return { ...adminActor(), userId: "user-1", isInstanceAdmin: false };
}

function makeJobDeps(job: Record<string, unknown> | null) {
  const jobStore = {
    getJobByIdForPlugin: vi.fn().mockResolvedValue(job),
    updateJobStatus: vi.fn().mockResolvedValue(undefined),
  };
  const scheduler = { scheduleJob: vi.fn().mockResolvedValue(undefined) };
  return { jobStore, scheduler, jobDeps: { scheduler, jobStore } };
}

async function createApp(actor: Record<string, unknown>, jobDeps?: unknown) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    jobDeps as never,
  ));
  app.use(errorHandler);
  return app;
}

function readyPlugin() {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
  });
}

const url = `/api/plugins/${pluginId}/jobs/job-1`;
const pausedJob = { id: "job-1", jobKey: "sync.example", status: "paused" };

// The first request cold-imports the whole plugin route module graph.
describe.sequential("PATCH /plugins/:pluginId/jobs/:jobId", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyPlugin();
  });

  it("lets an instance admin resume a paused job and writes one audit entry", async () => {
    const { jobStore, scheduler, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      jobId: "job-1",
      jobKey: "sync.example",
      status: "active",
      previousStatus: "paused",
      changed: true,
    });
    expect(jobStore.updateJobStatus).toHaveBeenCalledTimes(1);
    // The schedule pointer is initialized after the status write, so a job
    // whose nextRunAt is null or stale actually fires again.
    expect(scheduler.scheduleJob).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleJob).toHaveBeenCalledWith("job-1");
    expect(jobStore.updateJobStatus.mock.invocationCallOrder[0]).toBeLessThan(
      scheduler.scheduleJob.mock.invocationCallOrder[0] as number,
    );
    expect(jobStore.updateJobStatus).toHaveBeenCalledWith("job-1", "active");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]?.[1]).toMatchObject({
      companyId: companyA,
      action: "plugin.job_status_changed",
      entityType: "plugin_job",
      entityId: "job-1",
      details: {
        pluginId,
        jobId: "job-1",
        jobKey: "sync.example",
        from: "paused",
        to: "active",
      },
    });
  });

  it("lets an instance admin pause an active job", async () => {
    const { jobStore, scheduler, jobDeps } = makeJobDeps({ ...pausedJob, status: "active" });
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "paused" });

    expect(res.status).toBe(200);
    // Pausing keeps nextRunAt as it is (the tick only fires active jobs).
    expect(scheduler.scheduleJob).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ status: "paused", previousStatus: "active", changed: true });
    expect(jobStore.updateJobStatus).toHaveBeenCalledWith("job-1", "paused");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("returns changed:false without a write or audit entry when the status is unchanged", async () => {
    const { jobStore, scheduler, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(scheduler.scheduleJob).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      jobId: "job-1",
      jobKey: "sync.example",
      status: "paused",
      previousStatus: "paused",
      changed: false,
    });
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["failed status", { status: "failed" }],
    ["missing status", {}],
    ["non-string status", { status: 1 }],
    ["unknown extra field", { status: "active", companyId: "x" }],
  ])("rejects %s with 400 and no write", async (_name, body) => {
    const { jobStore, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send(body);

    expect(res.status).toBe(400);
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    const { jobStore, jobDeps } = makeJobDeps(null);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(404);
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown plugin", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const { jobStore, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(404);
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin board user and does not touch the store", async () => {
    const { jobStore, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(memberActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(403);
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 501 when job scheduling is not enabled", async () => {
    const app = await createApp(adminActor(), undefined);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(501);
  });
});
