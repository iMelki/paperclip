import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/**
 * Route + real scheduler + an in-memory job row. A scheduler tick is injected
 * around every store write, so a resume that flips the status before arming
 * the schedule is caught dispatching the missed run.
 */

const mockRegistry = vi.hoisted(() => ({ getById: vi.fn(), getByKey: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyA = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "job-1";
const url = `/api/plugins/${pluginId}/jobs/${JOB_ID}`;
const DAY = 24 * 3_600_000;

type Row = {
  id: string;
  pluginId: string;
  jobKey: string;
  schedule: string | null;
  status: "active" | "paused" | "failed";
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeWorld(initial: Partial<Row>) {
  const row: Row = {
    id: JOB_ID,
    pluginId,
    jobKey: "sync.example",
    schedule: "*/5 * * * *",
    status: "paused",
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  let failNextArmingWrite = false;
  let scheduler: ReturnType<typeof createPluginJobScheduler>;
  const createRun = vi.fn(async () => ({ id: "run-1", companyId: null }));
  const maybeFail = () => {
    if (failNextArmingWrite) {
      failNextArmingWrite = false;
      throw new Error("injected arming write failure");
    }
  };
  const tickAround = async (write: () => void) => {
    await scheduler.tick(); // a tick lands just before the write
    write();
    await scheduler.tick(); // and one just after it
  };

  const jobStore = {
    getJobById: vi.fn(async () => ({ ...row })),
    getJobByIdForPlugin: vi.fn(async () => ({ ...row })),
    getJobDeclarationScope: vi.fn(async () => "instance"),
    createRun,
    markRunning: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    listJobs: vi.fn(async () => []),
    updateJobStatus: vi.fn(async (_id: string, status: Row["status"], opts?: { nextRunAt?: Date | null }) => {
      if (opts?.nextRunAt) maybeFail();
      await tickAround(() => {
        row.status = status;
        if (opts?.nextRunAt !== undefined) row.nextRunAt = opts.nextRunAt;
      });
    }),
    updateNextRunAt: vi.fn(async (_id: string, next: Date | null) => {
      maybeFail();
      await tickAround(() => {
        row.nextRunAt = next;
      });
    }),
    updateRunTimestamps: vi.fn(async (_id: string, last: Date, next: Date | null) => {
      maybeFail();
      row.lastRunAt = last;
      row.nextRunAt = next;
    }),
  } as unknown as PluginJobStore;

  const db = {
    select: () => ({
      from: () => ({
        where: async () =>
          row.status === "active" && row.nextRunAt && row.nextRunAt.getTime() <= Date.now()
            ? [{ ...row }]
            : [],
      }),
    }),
  } as unknown as Db;
  const workerManager = {
    isRunning: vi.fn(() => true),
    getProactiveCompanyScopes: vi.fn(() => []),
    call: vi.fn(async () => undefined),
  } as unknown as PluginWorkerManager;
  scheduler = createPluginJobScheduler({ db, jobStore, workerManager, jobTimeoutMs: 1_000 });

  return {
    row,
    scheduler,
    jobStore,
    createRun,
    failNextArmingWrite: () => {
      failNextArmingWrite = true;
    },
  };
}

async function createApp(world: ReturnType<typeof makeWorld>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    { scheduler: world.scheduler, jobStore: world.jobStore } as never,
  ));
  app.use(errorHandler);
  return app;
}

describe.sequential("resume arms the schedule safely", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
    });
  });

  it("does not dispatch the missed run when ticks race a resume of a long-paused job", async () => {
    const world = makeWorld({ nextRunAt: new Date(Date.now() - 3 * DAY) });
    const app = await createApp(world);
    const before = Date.now();

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "active", previousStatus: "paused", changed: true });
    expect(world.createRun).not.toHaveBeenCalled();
    expect(world.row.status).toBe("active");
    expect(world.row.nextRunAt!.getTime()).toBeGreaterThan(before);
    expect(world.row.lastRunAt).toBeNull();
  });

  it("schedules a future run for a paused job with a null nextRunAt, never touching lastRunAt", async () => {
    const world = makeWorld({ nextRunAt: null });
    const app = await createApp(world);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(world.row.status).toBe("active");
    expect(world.row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(world.row.lastRunAt).toBeNull();
    expect(world.createRun).not.toHaveBeenCalled();
  });

  it("returns an error and never leaves an unarmed active job when arming fails, then a retry succeeds", async () => {
    const world = makeWorld({ nextRunAt: null });
    const app = await createApp(world);
    world.failNextArmingWrite();

    const failed = await request(app).patch(url).send({ status: "active" });

    expect(failed.status).toBe(500);
    expect(world.row.status === "active" && world.row.nextRunAt === null).toBe(false);

    const retry = await request(app).patch(url).send({ status: "active" });

    expect(retry.status).toBe(200);
    expect(world.row.status).toBe("active");
    expect(world.row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("repairs an already-active job with a null nextRunAt on a no-change request", async () => {
    const world = makeWorld({ status: "active", nextRunAt: null });
    const app = await createApp(world);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "active", previousStatus: "active", changed: false });
    expect(world.row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses to resume a job whose schedule never produces a run and leaves it paused", async () => {
    const world = makeWorld({ schedule: "0 0 31 2 *", nextRunAt: null });
    const app = await createApp(world);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(422);
    expect(world.row.status).toBe("paused");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("resumes a manual-only job (no schedule) without arming anything", async () => {
    const world = makeWorld({ schedule: null, nextRunAt: null });
    const app = await createApp(world);

    const res = await request(app).patch(url).send({ status: "active" });

    expect(res.status).toBe(200);
    expect(world.row.status).toBe("active");
    expect(world.row.nextRunAt).toBeNull();
  });

  it("keeps a future nextRunAt on resume and leaves nextRunAt alone on pause", async () => {
    const future = new Date(Date.now() + 60_000);
    const world = makeWorld({ nextRunAt: future });
    const app = await createApp(world);

    await request(app).patch(url).send({ status: "active" });
    expect(world.row.nextRunAt).toEqual(future);

    await request(app).patch(url).send({ status: "paused" });
    expect(world.row.status).toBe("paused");
    expect(world.row.nextRunAt).toEqual(future);
  });
});
