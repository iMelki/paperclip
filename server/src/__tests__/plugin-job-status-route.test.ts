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
  const scheduler = { activateJob: vi.fn().mockResolvedValue(undefined), repairActiveJob: vi.fn().mockResolvedValue(false) };
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
    // Resume goes through the scheduler, which writes status and nextRunAt
    // together; the route does not flip the status separately first.
    expect(scheduler.activateJob).toHaveBeenCalledTimes(1);
    expect(scheduler.activateJob).toHaveBeenCalledWith("job-1");
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
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
    expect(scheduler.activateJob).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ status: "paused", previousStatus: "active", changed: true });
    expect(jobStore.updateJobStatus).toHaveBeenCalledWith("job-1", "paused");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("returns changed:false without a write or audit entry when the status is unchanged", async () => {
    const { jobStore, scheduler, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(scheduler.activateJob).not.toHaveBeenCalled();
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

  it("a no-change active request only repairs: no resume, changed:false and no audit when nothing was repaired", async () => {
    const { jobStore, scheduler, jobDeps } = makeJobDeps({ ...pausedJob, status: "active" });
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "active", previousStatus: "active", changed: false });
    expect(scheduler.repairActiveJob).toHaveBeenCalledWith("job-1");
    expect(scheduler.activateJob).not.toHaveBeenCalled();
    expect(jobStore.updateJobStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("reports changed:true with an audit entry when the repair wrote", async () => {
    const { scheduler, jobDeps } = makeJobDeps({ ...pausedJob, status: "active" });
    scheduler.repairActiveJob.mockResolvedValueOnce(true);
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.body).toMatchObject({ status: "active", previousStatus: "active", changed: true });
    expect(scheduler.activateJob).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]?.[1]).toMatchObject({ action: "plugin.job_schedule_repaired" });
  });

  it("a no-change paused request never touches the scheduler", async () => {
    const { scheduler, jobDeps } = makeJobDeps(pausedJob);
    const app = await createApp(adminActor(), jobDeps);

    await request(app).patch(url).send({ status: "paused" });

    expect(scheduler.repairActiveJob).not.toHaveBeenCalled();
    expect(scheduler.activateJob).not.toHaveBeenCalled();
  });

  it("returns 422 and writes no audit entry when the schedule cannot be armed", async () => {
    const { PluginJobScheduleError } = await import("../services/plugin-job-scheduler.js");
    const { scheduler, jobDeps } = makeJobDeps(pausedJob);
    scheduler.activateJob.mockRejectedValueOnce(new PluginJobScheduleError("never runs"));
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(422);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns an error, not success, when arming throws", async () => {
    const { scheduler, jobDeps } = makeJobDeps(pausedJob);
    scheduler.activateJob.mockRejectedValueOnce(new Error("db down"));
    const app = await createApp(adminActor(), jobDeps);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(500);
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
