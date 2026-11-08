import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const JOB_ID = "job-1";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    pluginId: "plugin-1",
    jobKey: "sync.example",
    schedule: "*/5 * * * *",
    status: "active" as const,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(job: ReturnType<typeof makeJob> | null) {
  const updateRunTimestamps = vi.fn(async () => undefined);
  const jobStore = {
    getJobById: vi.fn(async () => job),
    updateRunTimestamps,
  } as unknown as PluginJobStore;
  const scheduler = createPluginJobScheduler({
    db: {} as unknown as Db,
    jobStore,
    workerManager: {} as unknown as PluginWorkerManager,
  });
  return { scheduler, updateRunTimestamps };
}

describe("plugin job scheduler scheduleJob (resume)", () => {
  it("schedules a future run when nextRunAt is null", async () => {
    const { scheduler, updateRunTimestamps } = setup(makeJob({ nextRunAt: null }));
    const before = Date.now();

    await scheduler.scheduleJob(JOB_ID);

    expect(updateRunTimestamps).toHaveBeenCalledTimes(1);
    const [id, , next] = updateRunTimestamps.mock.calls[0] as unknown as [string, Date, Date];
    expect(id).toBe(JOB_ID);
    expect(next.getTime()).toBeGreaterThan(before);
    expect(next.getTime()).toBeLessThanOrEqual(before + 5 * 60_000 + 1_000);
  });

  it("recomputes a stale past nextRunAt instead of replaying the missed run", async () => {
    const stale = new Date(Date.now() - 3 * 24 * 3_600_000);
    const { scheduler, updateRunTimestamps } = setup(makeJob({ nextRunAt: stale }));
    const before = Date.now();

    await scheduler.scheduleJob(JOB_ID);

    expect(updateRunTimestamps).toHaveBeenCalledTimes(1);
    const [, , next] = updateRunTimestamps.mock.calls[0] as unknown as [string, Date, Date];
    expect(next.getTime()).toBeGreaterThan(before);
  });

  it("keeps a nextRunAt that is already in the future", async () => {
    const { scheduler, updateRunTimestamps } = setup(
      makeJob({ nextRunAt: new Date(Date.now() + 60_000) }),
    );

    await scheduler.scheduleJob(JOB_ID);

    expect(updateRunTimestamps).not.toHaveBeenCalled();
  });

  it.each([
    ["a manual-only job (no schedule)", makeJob({ schedule: null })],
    ["an invalid cron schedule", makeJob({ schedule: "not a cron" })],
    ["a paused job", makeJob({ status: "paused" })],
    ["a missing job", null],
  ])("does nothing for %s", async (_name, job) => {
    const { scheduler, updateRunTimestamps } = setup(job as ReturnType<typeof makeJob> | null);

    await scheduler.scheduleJob(JOB_ID);

    expect(updateRunTimestamps).not.toHaveBeenCalled();
  });
});
