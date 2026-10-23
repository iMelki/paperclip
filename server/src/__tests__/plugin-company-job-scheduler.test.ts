/** Actual scheduler + pure batch helper; all DB/worker ports are offline fakes. */
import { describe, expect, it, vi } from "vitest";
import { pluginJobs } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobDispatchPlan } from "../services/plugin-job-scope.js";

vi.mock("../middleware/logger.js", () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return { logger };
});
vi.mock("@paperclipai/plugin-sdk", () => ({ PLUGIN_RPC_ERROR_CODES: { TIMEOUT: -32003 } }));

const job = { id: "job-synthetic", pluginId: "plugin-synthetic", jobKey: "sync.synthetic", status: "active",
  schedule: "* * * * *", nextRunAt: new Date("2026-10-23T00:00:00Z") };
type Run = { id: string; jobId: string; pluginId: string; companyId: string | null; trigger: string;
  status: string; error?: string; startedAt?: Date };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture(initialPlan?: PluginJobDispatchPlan) {
  const rows: Run[] = [];
  let plan = initialPlan;
  let blockedRead: Promise<Run[]> | undefined;
  let blockedListing: Promise<Array<typeof job>> | undefined;
  const db = { select: vi.fn(() => ({ from: (table: unknown) => ({ where: async () => table === pluginJobs
    ? [job] : blockedRead ?? rows.filter((row) => ["running", "queued"].includes(row.status)) }) })) };
  const store = {
    getJobById: vi.fn(async () => job), listJobs: vi.fn(async () => blockedListing ?? [job]),
    getRunById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    createRun: vi.fn(async (input: Omit<Run, "id" | "status">) => {
      const row = { ...input, companyId: input.companyId ?? null, id: `run-${rows.length + 1}`, status: "queued" };
      rows.push(row); return row;
    }),
    markRunning: vi.fn(async (id: string) => {
      const row = rows.find((item) => item.id === id)!;
      if (row.status === "queued") { row.status = "running"; row.startedAt = new Date(); }
    }),
    completeRun: vi.fn(async (id: string, value: { status: string; error?: string }) => {
      const row = rows.find((item) => item.id === id)!;
      if (["pending", "queued", "running"].includes(row.status)) Object.assign(row, value);
    }),
    updateRunTimestamps: vi.fn(async () => undefined),
  };
  const worker = { isRunning: vi.fn(() => true), call: vi.fn(async (..._args: unknown[]) => undefined) };
  const resolve = vi.fn(async () => plan!);
  const scheduler = createPluginJobScheduler({ db: db as never, jobStore: store as never,
    workerManager: worker as never, jobTimeoutMs: 10000,
    ...(initialPlan ? { resolveJobDispatch: resolve } : {}) });
  return { rows, store, worker, resolve, scheduler, setPlan: (value: PluginJobDispatchPlan) => { plan = value; },
    blockRead: (value: Promise<Run[]>) => { blockedRead = value; },
    blockListing: (value: Promise<Array<typeof job>>) => { blockedListing = value; } };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("Synthetic scheduler did not settle within 100 microtask turns");
}
const companyPlan = { scope: "company" as const, companyIds: ["company-a", "company-b"] };

describe("actual scheduler company dispatch wiring", () => {
  it("preserves one legacy unscoped dispatch with no resolver", async () => {
    const f = fixture(); await f.scheduler.tick();
    expect(f.worker.call).toHaveBeenCalledTimes(1);
    expect(f.worker.call.mock.calls[0]?.[2]).toEqual({ job: { jobKey: job.jobKey, runId: "run-1",
      trigger: "schedule", scheduledAt: job.nextRunAt.toISOString() } });
    expect(f.rows).toMatchObject([{ companyId: null, status: "succeeded" }]);
  });
  it("creates and completes separate company rows with matching invocation envelopes", async () => {
    const f = fixture(companyPlan); await f.scheduler.tick();
    expect(f.rows.map((row) => [row.id, row.companyId, row.status])).toEqual([
      ["run-1", "company-a", "succeeded"], ["run-2", "company-b", "succeeded"]]);
    for (const [index, companyId] of companyPlan.companyIds.entries()) {
      expect(f.worker.call.mock.calls[index]?.[2]).toMatchObject({ companyId,
        job: { companyId, runId: `run-${index + 1}`, trigger: "schedule" } });
    }
    expect(f.store.updateRunTimestamps).toHaveBeenCalledTimes(1);
  });
  it.each(["empty", "lookup-error"])("records %s without an unscoped fallback", async (kind) => {
    const f = fixture({ scope: "company", companyIds: [] });
    if (kind === "lookup-error") f.resolve.mockRejectedValue(new Error("synthetic resolver unavailable"));
    await f.scheduler.tick();
    expect(f.worker.call).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ companyId: null, status: "failed" });
    expect(f.store.updateRunTimestamps).toHaveBeenCalledTimes(1);
  });
  it("manual dispatch is also scoped and returns each execution ID", async () => {
    const f = fixture(companyPlan); const result = await f.scheduler.triggerJob(job.id);
    await until(() => f.scheduler.diagnostics().activeJobCount === 0);
    expect(result).toEqual({ jobId: job.id, runId: "run-1", runs: [
      { runId: "run-1", companyId: "company-a" }, { runId: "run-2", companyId: "company-b" }] });
    expect(f.rows.map((row) => row.trigger)).toEqual(["manual", "manual"]);
    expect(f.worker.call).toHaveBeenCalledTimes(2);
  });
  it("retry resolves the prior persisted company and cannot replay all companies", async () => {
    const f = fixture(companyPlan);
    f.rows.push({ id: "prior-b", jobId: job.id, pluginId: job.pluginId, companyId: "company-b",
      trigger: "schedule", status: "failed" });
    await expect(f.scheduler.triggerJob(job.id, "retry")).rejects.toThrow("original company ID");
    expect(f.worker.call).not.toHaveBeenCalled();
    const result = await f.scheduler.triggerJob(job.id, "retry", "prior-b");
    await until(() => f.scheduler.diagnostics().activeJobCount === 0);
    expect(result.runs).toEqual([{ runId: "run-2", companyId: "company-b" }]);
    expect(f.worker.call).toHaveBeenCalledTimes(1);
    expect(f.worker.call.mock.calls[0]?.[2]).toMatchObject({ companyId: "company-b",
      job: { trigger: "retry", companyId: "company-b" } });
  });
  it("rejects a prior run belonging to another job before creating executions", async () => {
    const f = fixture(companyPlan);
    f.rows.push({ id: "other", jobId: "different-job", pluginId: job.pluginId, companyId: "company-a",
      trigger: "schedule", status: "failed" });
    await expect(f.scheduler.triggerJob(job.id, "retry", "other")).rejects.toThrow("exact plugin job");
    expect(f.store.createRun).not.toHaveBeenCalled(); expect(f.worker.call).not.toHaveBeenCalled();
  });
  it("prevents two simultaneous manual triggers from claiming the same job", async () => {
    const f = fixture(companyPlan); const work = deferred<void>();
    f.worker.call.mockImplementation(async () => work.promise);
    const first = f.scheduler.triggerJob(job.id); const second = f.scheduler.triggerJob(job.id);
    await expect(second).rejects.toThrow("already running"); await first;
    work.resolve(); await until(() => f.scheduler.diagnostics().activeJobCount === 0);
    expect(f.rows).toHaveLength(2); expect(f.worker.call).toHaveBeenCalledTimes(2);
  });
  it("revokes synchronously while unregister DB lookup stalls; no B or stale pointer update", async () => {
    const f = fixture(companyPlan); const work = deferred<void>(); const query = deferred<Run[]>();
    f.worker.call.mockImplementationOnce(async () => work.promise);
    const tick = f.scheduler.tick(); await until(() => f.worker.call.mock.calls.length === 1);
    f.blockRead(query.promise); const unregister = f.scheduler.unregisterPlugin(job.pluginId);
    await expect(f.scheduler.registerPlugin(job.pluginId)).rejects.toThrow("cleanup is still in progress");
    work.resolve(); await tick;
    expect(f.worker.call).toHaveBeenCalledTimes(1); expect(f.store.updateRunTimestamps).not.toHaveBeenCalled();
    query.resolve(f.rows); await unregister;
    expect(f.rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    await f.scheduler.registerPlugin(job.pluginId); await f.scheduler.tick();
    expect(f.worker.call).toHaveBeenCalledTimes(3);
    expect(f.rows.slice(0, 2).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
  });
  it("does not dispatch removed company B using a stale batch snapshot", async () => {
    const f = fixture(companyPlan);
    f.worker.call.mockImplementationOnce(async () => { f.setPlan({ scope: "company", companyIds: ["company-a"] }); });
    await f.scheduler.tick();
    expect(f.worker.call).toHaveBeenCalledTimes(1);
    expect(f.rows[1]).toMatchObject({ companyId: "company-b", status: "failed" });
  });
  it("a registration awaiting DB work cannot undo a later completed unregister", async () => {
    const f = fixture(companyPlan); const listing = deferred<Array<typeof job>>();
    f.blockListing(listing.promise);
    const registration = f.scheduler.registerPlugin(job.pluginId);
    const rejected = expect(registration).rejects.toThrow("unregistered during registration");
    await f.scheduler.unregisterPlugin(job.pluginId);
    listing.resolve([job]); await rejected;
    await expect(f.scheduler.triggerJob(job.id)).rejects.toThrow("unregistered");
    expect(f.worker.call).not.toHaveBeenCalled(); expect(f.store.updateRunTimestamps).not.toHaveBeenCalled();
  });
});
