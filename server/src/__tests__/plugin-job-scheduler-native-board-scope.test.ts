import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_ID = "plugin-1";
const JOB_ID = "job-1";

function setup(opts: { grantedCompanyIds: string[]; authorizedCompanyIds: string[]; workerRegistered?: boolean }) {
  const job = {
    id: JOB_ID,
    pluginId: PLUGIN_ID,
    jobKey: "sync.github-project-board",
    schedule: "*/5 * * * *",
    status: "active" as const,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() - 1_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const createRun = vi.fn(async (input: { companyId?: string | null }) => ({
    id: "run-1",
    companyId: input.companyId ?? null,
  }));
  const jobStore = {
    getJobById: vi.fn(async () => job),
    getJobDeclarationScope: vi.fn(async () => "company"),
    createRun,
    markRunning: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    updateRunTimestamps: vi.fn(async () => undefined),
    listJobs: vi.fn(async () => []),
  } as unknown as PluginJobStore;
  const workerManager = {
    isRunning: vi.fn(() => false),
    // A registered (here stopped) worker handle carries the authorized set.
    getWorker: vi.fn(() => (opts.workerRegistered === false ? undefined : {})),
    getProactiveCompanyScopes: vi.fn(() => [...opts.authorizedCompanyIds]),
    setProactiveCompanyScopes: vi.fn(),
    call: vi.fn(),
  } as unknown as PluginWorkerManager;
  const nativeRun = vi.fn(async () => ({ status: "verified" }));
  const scheduler = createPluginJobScheduler({
    db: { select: () => ({ from: () => ({ where: async () => [job] }) }) } as unknown as Db,
    jobStore,
    workerManager,
    jobTimeoutMs: 1_000,
    nativeGitHubProjectBoard: {
      matches: () => true,
      resolveDispatch: vi.fn(async () => ({ scope: "company" as const, companyIds: opts.grantedCompanyIds })),
      reconcileDeclarations: vi.fn(async (_pluginId, _pluginKey, declarations) => declarations),
      run: nativeRun,
      cancelPlugin: vi.fn(),
      stop: vi.fn(),
    },
  });
  return { scheduler, createRun, nativeRun, workerManager, jobStore };
}

describe("native GitHub board job authorization", () => {
  it("does not run a grant for a company outside the authorized set, and does not run unscoped", async () => {
    const ctx = setup({ grantedCompanyIds: ["company-grant"], authorizedCompanyIds: ["company-authorized"] });

    await ctx.scheduler.tick();

    expect(ctx.workerManager.getProactiveCompanyScopes).toHaveBeenCalledWith(PLUGIN_ID);
    expect(ctx.createRun).not.toHaveBeenCalled();
    expect(ctx.nativeRun).not.toHaveBeenCalled();
  });

  it("does not run unscoped when the grant list is empty", async () => {
    const ctx = setup({ grantedCompanyIds: [], authorizedCompanyIds: ["company-authorized"] });

    await ctx.scheduler.tick();

    expect(ctx.createRun).not.toHaveBeenCalled();
    expect(ctx.nativeRun).not.toHaveBeenCalled();
  });

  it("runs only a company that is both granted and authorized", async () => {
    const ctx = setup({
      grantedCompanyIds: ["company-grant", "company-authorized"],
      authorizedCompanyIds: ["company-authorized"],
    });

    await ctx.scheduler.tick();

    expect(ctx.createRun).toHaveBeenCalledTimes(1);
    expect(ctx.createRun).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-authorized" }));
    expect(ctx.nativeRun).toHaveBeenCalledTimes(1);
  });

  it("leaves the job due, without a run or a schedule advance, while the worker is unregistered", async () => {
    const ctx = setup({
      grantedCompanyIds: ["company-authorized"],
      authorizedCompanyIds: [],
      workerRegistered: false,
    });

    await ctx.scheduler.tick();

    expect(ctx.createRun).not.toHaveBeenCalled();
    expect(ctx.nativeRun).not.toHaveBeenCalled();
    expect(ctx.jobStore.updateRunTimestamps).not.toHaveBeenCalled();
  });
});
