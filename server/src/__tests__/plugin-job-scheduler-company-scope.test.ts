import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_ID = "plugin-1";
const JOB_ID = "job-1";

function makeJob() {
  return {
    id: JOB_ID,
    pluginId: PLUGIN_ID,
    jobKey: "sync.github-issues",
    schedule: "*/5 * * * *",
    status: "active" as const,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() - 1_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(opts: {
  scope: "company" | "instance";
  companyIds: string[];
  runJob?: (params: { job: { runId: string; companyId?: string | null }; companyId?: string | null }) => Promise<void>;
}) {
  const job = makeJob();
  let nextRun = 0;
  const createRun = vi.fn(async (input: { companyId?: string | null }) => ({
    id: `run-${++nextRun}`,
    companyId: input.companyId ?? null,
  }));
  const completeRun = vi.fn(async () => undefined);
  const markRunning = vi.fn(async () => undefined);
  const jobStore = {
    getJobById: vi.fn(async () => job),
    getJobDeclarationScope: vi.fn(async () => opts.scope),
    createRun,
    markRunning,
    completeRun,
    updateRunTimestamps: vi.fn(async () => undefined),
    listJobs: vi.fn(async () => []),
  } as unknown as PluginJobStore;

  const call = vi.fn(async (_pluginId: string, _method: string, params: unknown) => {
    await opts.runJob?.(params as Parameters<NonNullable<typeof opts.runJob>>[0]);
    return undefined;
  });
  const workerManager = {
    isRunning: vi.fn(() => true),
    getProactiveCompanyScopes: vi.fn(() => [...opts.companyIds]),
    call,
  } as unknown as PluginWorkerManager;

  // tick() reads due jobs; triggerJob() reads running runs (none).
  let whereResult: unknown[] = [job];
  const db = {
    select: () => ({ from: () => ({ where: async () => whereResult }) }),
  } as unknown as Db;

  const scheduler = createPluginJobScheduler({ db, jobStore, workerManager, jobTimeoutMs: 1_000 });
  return {
    scheduler,
    job,
    createRun,
    completeRun,
    markRunning,
    call,
    setWhereResult: (rows: unknown[]) => {
      whereResult = rows;
    },
  };
}

function runJobParams(call: ReturnType<typeof vi.fn>) {
  return call.mock.calls.map((args) => args[2] as {
    job: { runId: string; companyId?: string | null; trigger: string };
    companyId?: string | null;
  });
}

describe("plugin job scheduler company scope", () => {
  it("runs a company-scoped scheduled job once per configured company, each with its own run record and run id", async () => {
    const ctx = setup({ scope: "company", companyIds: ["company-b", "company-a"] });
    await ctx.scheduler.tick();

    expect(ctx.createRun.mock.calls.map((args) => args[0])).toEqual([
      { jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "schedule", companyId: "company-a" },
      { jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "schedule", companyId: "company-b" },
    ]);
    const params = runJobParams(ctx.call);
    expect(params).toHaveLength(2);
    expect(params.map((p) => [p.companyId, p.job.companyId, p.job.runId])).toEqual([
      ["company-a", "company-a", "run-1"],
      ["company-b", "company-b", "run-2"],
    ]);
    expect(ctx.completeRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "succeeded" }));
    expect(ctx.completeRun).toHaveBeenCalledWith("run-2", expect.objectContaining({ status: "succeeded" }));
  });

  it.each([
    { scope: "instance" as const, companyIds: ["company-a", "company-b"] },
    { scope: "instance" as const, companyIds: [] },
    { scope: "company" as const, companyIds: [] },
  ])("runs a $scope-scoped job once, unscoped, with companies $companyIds", async ({ scope, companyIds }) => {
    const ctx = setup({ scope, companyIds });
    await ctx.scheduler.tick();

    expect(ctx.createRun).toHaveBeenCalledTimes(1);
    expect(ctx.createRun).toHaveBeenCalledWith(expect.objectContaining({ companyId: null }));
    const params = runJobParams(ctx.call);
    expect(params).toHaveLength(1);
    expect(params[0]).not.toHaveProperty("companyId");
    expect(params[0]!.job).not.toHaveProperty("companyId");
  });

  it("records each company's run separately when one company's run fails, and still runs the others", async () => {
    const ctx = setup({
      scope: "company",
      companyIds: ["company-a", "company-b"],
      runJob: async (params) => {
        if (params.companyId === "company-a") throw new Error("company-a token missing");
      },
    });
    await ctx.scheduler.tick();

    expect(ctx.call).toHaveBeenCalledTimes(2);
    expect(ctx.completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "failed", error: "company-a token missing" }),
    );
    expect(ctx.completeRun).toHaveBeenCalledWith("run-2", expect.objectContaining({ status: "succeeded" }));
  });

  it("returns one run per configured company from a manual trigger of a company-scoped job", async () => {
    const ctx = setup({ scope: "company", companyIds: ["company-a", "company-b"] });
    ctx.setWhereResult([]);
    const result = await ctx.scheduler.triggerJob(JOB_ID, "manual");

    expect(result).toEqual({
      runId: "run-1",
      jobId: JOB_ID,
      runs: [
        { runId: "run-1", companyId: "company-a" },
        { runId: "run-2", companyId: "company-b" },
      ],
    });
    await vi.waitFor(() => expect(ctx.completeRun).toHaveBeenCalledTimes(2));
    expect(runJobParams(ctx.call).map((p) => [p.companyId, p.job.runId, p.job.trigger])).toEqual([
      ["company-a", "run-1", "manual"],
      ["company-b", "run-2", "manual"],
    ]);
  });

  it("retries a company-scoped job for one named company only", async () => {
    const ctx = setup({ scope: "company", companyIds: ["company-a", "company-b"] });
    ctx.setWhereResult([]);
    const result = await ctx.scheduler.triggerJob(JOB_ID, "retry", { companyId: "company-b" });

    expect(result.runs).toEqual([{ runId: "run-1", companyId: "company-b" }]);
    expect(ctx.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "retry", companyId: "company-b" }),
    );
    await vi.waitFor(() => expect(ctx.completeRun).toHaveBeenCalledTimes(1));
    expect(runJobParams(ctx.call).map((p) => p.companyId)).toEqual(["company-b"]);
  });

  it("rejects a per-company trigger for an unconfigured company or an instance-scoped job", async () => {
    const company = setup({ scope: "company", companyIds: ["company-a"] });
    company.setWhereResult([]);
    await expect(company.scheduler.triggerJob(JOB_ID, "manual", { companyId: "company-z" }))
      .rejects.toThrow(/has not configured plugin/);

    const instance = setup({ scope: "instance", companyIds: ["company-a"] });
    instance.setWhereResult([]);
    await expect(instance.scheduler.triggerJob(JOB_ID, "manual", { companyId: "company-a" }))
      .rejects.toThrow(/instance-scoped/);
    expect(company.createRun).not.toHaveBeenCalled();
    expect(instance.createRun).not.toHaveBeenCalled();
  });
});
