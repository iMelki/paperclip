import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { plugins, pluginJobs, pluginJobRuns, type Db } from "@paperclipai/db";
import type { PluginJobDeclaration } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { GITHUB_PROJECT_IMPORTER_KEY } from "./plugin-github-project-board.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY } from "./github-project-schedule-grant-contract.js";
import { createScheduledGitHubProjectBoardService } from "./plugin-github-project-scheduled.js";
import type { ScheduledGitHubPageReader } from "./github-project-scheduled-contract.js";
import type { createPluginJobEnvelope, PluginJobDispatchPlan } from "./plugin-job-scope.js";
import { isNativeGitHubBoardJobKey, readNativeBoardJobTargets } from "./github-project-board-job-targets.js";
export { isNativeGitHubBoardJobKey } from "./github-project-board-job-targets.js";

type Job = Pick<typeof pluginJobs.$inferSelect, "id" | "pluginId" | "jobKey">;
type Envelope = ReturnType<typeof createPluginJobEnvelope>;
const MAX_NATIVE_BATCH_MS = 120_000;
interface ActiveRun { pluginId: string; controller: AbortController }

/** Native-only execution port for the EXISTING scheduler. It owns no tick or detached execution. */
export function createGitHubProjectBoardSchedulerBridge(db: Db, reader: ScheduledGitHubPageReader,
  options: { enabled?: boolean } = {}) {
  const active = new Map<string, ActiveRun>();
  let stopped = false;
  const assertEnabled = () => {
    if (options.enabled !== true || stopped) throw forbidden("Native GitHub board scheduling is disabled");
  };
  const assertNative = (jobKey: string) => {
    if (!isNativeGitHubBoardJobKey(jobKey)) throw forbidden("Native board bridge refuses non-board jobs");
  };
  async function resolveDispatch(pluginId: string, jobKey: string): Promise<PluginJobDispatchPlan> {
    assertNative(jobKey); assertEnabled();
    const { targets } = await readNativeBoardJobTargets(db, pluginId);
    if (new Set(targets.map(target => target.companyId)).size !== targets.length) {
      throw forbidden("Native board scheduling permits exactly one board grant per company and job");
    }
    return { scope: "company", companyIds: [...new Set(targets.map(target => target.companyId))].sort() };
  }
  async function reconcileDeclarations(pluginId: string, pluginKey: string, declarations: PluginJobDeclaration[]) {
    if (pluginKey !== GITHUB_PROJECT_IMPORTER_KEY) return declarations;
    const [plugin] = await db.select().from(plugins).where(and(eq(plugins.id, pluginId),
      eq(plugins.pluginKey, GITHUB_PROJECT_IMPORTER_KEY))).limit(1);
    if (!plugin || plugin.status !== "ready") throw forbidden("Ready native GitHub plugin required for declaration registration");
    // Pre-insert paused BEFORE ordinary declaration synchronization, whose default for new jobs is active.
    await db.insert(pluginJobs).values({ pluginId, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY,
      schedule: "*/5 * * * *", status: "paused" }).onConflictDoNothing({ target: [pluginJobs.pluginId, pluginJobs.jobKey] });
    const [job] = await db.select().from(pluginJobs).where(and(eq(pluginJobs.pluginId, pluginId),
      eq(pluginJobs.jobKey, GITHUB_PROJECT_BOARD_JOB_KEY))).limit(1);
    if (!job) throw conflict("Native paused board registration readback failed");
    // No status, existing cron or pointer change; legacy repository declarations/status remain untouched.
    return [...declarations.filter(item => item.jobKey !== GITHUB_PROJECT_BOARD_JOB_KEY), {
      jobKey: GITHUB_PROJECT_BOARD_JOB_KEY, displayName: "Import granted GitHub project boards",
      description: "Host-owned, import-only board synchronization; never dispatches agents",
      schedule: job.schedule, dispatchScope: "company" as const,
    }];
  }
  async function run(job: Job, envelope: Envelope, timeoutMs: number, isCurrent: () => boolean) {
    assertNative(job.jobKey); assertEnabled();
    const companyId = envelope.companyId, runId = envelope.job.runId;
    if (envelope.job.jobKey !== job.jobKey || envelope.job.trigger !== "schedule"
      || typeof companyId !== "string" || envelope.job.companyId !== companyId
      || typeof isCurrent !== "function" || !isCurrent()
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || active.has(runId)) {
      throw forbidden("Exact native company schedule invocation required; manual/retry are refused");
    }
    const controller = new AbortController(), owned = { pluginId: job.pluginId, controller };
    const epoch = randomUUID(), started = performance.now(), budget = Math.min(timeoutMs, MAX_NATIVE_BATCH_MS);
    const current = () => !stopped && active.get(runId) === owned && isCurrent()
      && !controller.signal.aborted && performance.now() - started < budget;
    const timer = setTimeout(() => controller.abort(), budget); timer.unref();
    active.set(runId, owned);
    try {
      const { targets } = await readNativeBoardJobTargets(db, job.pluginId, job.id, companyId);
      if (targets.length !== 1) throw forbidden("Exactly one current native board grant required for this company run");
      const core = createScheduledGitHubProjectBoardService(db,
        { pluginId: job.pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, reader, { enabled: options.enabled === true });
      if (!current()) throw forbidden("Native board scheduler custody or deadline changed");
      const target = targets[0];
      const result = await core.run({ ...target, pluginId: job.pluginId, jobRunId: runId },
        { ownerEpoch: epoch, isCurrent: current, signal: controller.signal });
      if (result.status !== "verified" || !result.batchVerified || !result.progress) {
        throw conflict("Native board result held; inspect retained lease and receipts before retry");
      }
      if (!current()) throw forbidden("Native board scheduler custody changed before completion");
      const summary = { schema: "native-github-board-scheduled-batch.v1", status: "verified" as const,
        batchVerified: true, complete: result.complete, projectId: target.projectId,
        created: result.created, reused: result.reused, preservedExisting: result.preservedExisting, progress: result.progress,
        durationMs: Math.round(performance.now() - started) };
      const saved = await db.update(pluginJobRuns).set({
        logs: sql`coalesce(${pluginJobRuns.logs}, '[]'::jsonb) || jsonb_build_array(${JSON.stringify(summary)}::text)`,
      }).where(and(eq(pluginJobRuns.id, runId), eq(pluginJobRuns.pluginId, job.pluginId),
        eq(pluginJobRuns.jobId, job.id), eq(pluginJobRuns.companyId, companyId),
        eq(pluginJobRuns.trigger, "schedule"), eq(pluginJobRuns.status, "running"))).returning({ id: pluginJobRuns.id });
      if (saved.length !== 1 || !current()) throw conflict("Native board run changed before summary publication");
      return summary;
    } catch {
      // Neither provider errors nor external board data are copied into the scheduler run error string.
      throw conflict("Native board scheduled execution refused or held; inspect host-native receipts before retry");
    } finally {
      clearTimeout(timer); controller.abort();
      if (active.get(runId) === owned) active.delete(runId);
    }
  }
  function cancelPlugin(pluginId: string) {
    for (const owner of active.values()) if (owner.pluginId === pluginId) owner.controller.abort();
  }
  return Object.freeze({ matches: isNativeGitHubBoardJobKey, resolveDispatch, reconcileDeclarations, run, cancelPlugin,
    stop() { stopped = true; for (const owner of active.values()) owner.controller.abort(); } });
}
export type GitHubProjectBoardSchedulerBridge = ReturnType<typeof createGitHubProjectBoardSchedulerBridge>;
