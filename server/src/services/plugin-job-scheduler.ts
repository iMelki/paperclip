/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Before dispatching a job, the scheduler checks
 *    for an existing `running` run for the same job. If one exists, the job
 *    is skipped for that tick.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginJobs, pluginJobRuns } from "@paperclipai/db";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginJobStore } from "./plugin-job-store.js";
import {
  getTimedOutWorkerSettled,
  type PluginWorkerManager,
} from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";
import { selectPluginJobCompanies, type PluginJobDispatchPlan } from "./plugin-job-scope.js";
import { dispatchPluginJobBatch, type ScopedPluginJobRun } from "./plugin-job-batch.js";
import { isNativeGitHubBoardJobKey,
  type GitHubProjectBoardSchedulerBridge } from "./plugin-github-project-board-scheduler-bridge.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
export interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
  /**
   * After a company run of a company-scoped job times out, how long to wait
   * for the worker's handler to actually finish before giving up on the
   * remaining companies of that trigger (default: `jobTimeoutMs`).
   */
  timedOutRunGraceMs?: number;
  /** Host-persisted manifest/config only. Omitted retains legacy instance dispatch. */
  resolveJobDispatch?: (pluginId: string, jobKey: string) => Promise<PluginJobDispatchPlan>;
  /** Reserved host-only board jobs; absent handler NEVER authorizes worker fallback. */
  nativeGitHubProjectBoard?: GitHubProjectBoardSchedulerBridge;
}

/**
 * Options for a manual job trigger.
 */
export interface TriggerJobOptions {
  /**
   * Run a company-scoped job for this one configured company only (for a
   * per-company manual run or retry). Rejected for instance-scoped jobs and
   * for companies that have not configured the plugin.
   */
  companyId?: string | null;
  /** Retry the company of this prior failed or cancelled run of the same job. */
  retryRunId?: string;
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /** The created run ID. */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
  /** Per-company executions; runId remains the first run for older callers. */
  runs?: Array<{ runId: string; companyId: string | null }>;
}

/**
 * Diagnostic information about the scheduler.
 */
export interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /** Number of jobs currently executing. */
  activeJobCount: number;
  /** Set of job IDs currently in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * Cancels any in-flight runs for the plugin and removes tracking state.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Resume a non-active job: set it to `active` and arm its schedule in one
   * write.
   *
   * The schedule is always validated first. When the job's `nextRunAt` is null
   * or already past, the next run is computed from the cron schedule and stored
   * together with the status flip, so a scheduler tick can never see an active
   * job with a stale pointer (a missed run is skipped, not replayed). A future
   * `nextRunAt` is kept; a manual-only job (no schedule) is just activated.
   * `lastRunAt` is never touched.
   *
   * @param jobId - UUID of the job
   * @throws {PluginJobScheduleError} if the schedule is invalid or can never
   *   produce a next run; the job status is left unchanged
   */
  activateJob(jobId: string): Promise<void>;

  /**
   * Narrow repair for an `active` job stuck with a null `nextRunAt` (for
   * example after a failed earlier resume).
   *
   * Writes only when the row is still `active` with a null `nextRunAt` at
   * write time (conditional update), so it can never resume a job that was
   * paused concurrently. Never changes the status or `lastRunAt`.
   *
   * @param jobId - UUID of the job
   * @returns `true` if the pointer was armed, `false` if nothing needed doing
   * @throws {PluginJobScheduleError} if the schedule cannot produce a next run
   */
  repairActiveJob(jobId: string): Promise<boolean>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * @param jobId - UUID of the job to trigger
   * @param trigger - What triggered this run (default: "manual")
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, or already running
   */
  triggerJob(
    jobId: string,
    trigger?: "manual" | "retry",
    retryRunIdOrOptions?: string | TriggerJobOptions,
  ): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
/** A job's schedule cannot be armed (invalid cron, or no future occurrence). */
export class PluginJobScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginJobScheduleError";
  }
}

export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    resolveJobDispatch = async () => ({ scope: "instance" as const, companyIds: [] }),
    nativeGitHubProjectBoard,
  } = options;
  const timedOutRunGraceMs = options.timedOutRunGraceMs ?? jobTimeoutMs;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /** Set of job IDs currently being executed (for overlap prevention). */
  const activeJobs = new Set<string>();
  /** A new registration cannot revive the previous owner's in-flight batch. */
  const jobOwners = new Map<string, symbol>();
  const jobPlugins = new Map<string, string>();
  const unregisteredPlugins = new Set<string>();
  const unregisterOwners = new Map<string, symbol>();
  const pluginRevocations = new Map<string, number>();

  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      // Query for jobs whose nextRunAt has passed and are active.
      // We include jobs with null nextRunAt since they may have just been
      // registered and need their first run calculated.
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const job of dueJobs) {
        if (unregisteredPlugins.has(job.pluginId)) continue;
        // Concurrency limit
        if (activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeJobs.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Overlap prevention: skip if this job is already running
        if (activeJobs.has(job.id)) {
          log.debug(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
            "skipping job — already running (overlap prevention)",
          );
          continue;
        }

        // Check if the worker is available
        if (!isNativeGitHubBoardJobKey(job.jobKey) && !workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        // Validate cron expression before dispatching
        if (!job.schedule) {
          log.warn(
            { jobId: job.id, jobKey: job.jobKey },
            "skipping job — no schedule defined",
          );
          continue;
        }

        dispatches.push(dispatchJob(job));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  function claimJob(jobId: string, pluginId: string): symbol {
    if (unregisteredPlugins.has(pluginId)) throw new Error("Plugin jobs are unregistered");
    if (activeJobs.has(jobId)) throw new Error("Job is already running");
    const owner = Symbol(jobId);
    activeJobs.add(jobId);
    jobOwners.set(jobId, owner);
    jobPlugins.set(jobId, pluginId);
    return owner;
  }

  function releaseJob(jobId: string, owner: symbol): void {
    if (jobOwners.get(jobId) !== owner) return;
    jobOwners.delete(jobId);
    jobPlugins.delete(jobId);
    activeJobs.delete(jobId);
  }

  /**
   * Plan for a worker-run (non-native) job. `scope: "company"` and `dispatchScope: "company"` are
   * the same strict contract: the job runs once per host-configured company, nothing is dispatched
   * when no company is configured, and a retry needs the original company.
   */
  async function resolveWorkerJobDispatch(job: typeof pluginJobs.$inferSelect): Promise<PluginJobDispatchPlan> {
    const strict = await resolveJobDispatch(job.pluginId, job.jobKey);
    if (strict.scope === "company") return strict;
    const declared = await jobStore.getJobDeclarationScope(job.pluginId, job.jobKey);
    if (declared !== "company") return strict;
    const companyIds = [...workerManager.getProactiveCompanyScopes(job.pluginId)].sort();
    if (companyIds.length === 0) throw new Error("Company job has no host-configured companies; nothing dispatched");
    return { scope: "company", companyIds };
  }

  async function resolveDispatchPlan(job: typeof pluginJobs.$inferSelect): Promise<PluginJobDispatchPlan> {
    if (!isNativeGitHubBoardJobKey(job.jobKey)) return resolveWorkerJobDispatch(job);
    if (!nativeGitHubProjectBoard) throw new Error("Native GitHub board scheduler handler is unavailable; worker fallback refused");
    const plan = await nativeGitHubProjectBoard.resolveDispatch(job.pluginId, job.jobKey);
    // Grants are not a second authorization source. A company runs only when
    // it is also in the host-authorized set installed by setProactiveCompanyScopes.
    // An empty intersection does not fall back to an unscoped run.
    const authorized = new Set(workerManager.getProactiveCompanyScopes(job.pluginId));
    const companyIds = plan.companyIds.filter((companyId) => authorized.has(companyId));
    if (companyIds.length === 0) {
      throw new Error(
        `Plugin "${job.pluginId}" job "${job.jobKey}" has no company that is both granted and authorized`,
      );
    }
    return { ...plan, companyIds };
  }

  /** Errors thrown while inserting run records: the store is suspect, so no diagnostic row is attempted. */
  const runRecordFailures = new WeakSet<object>();

  async function prepareRuns(
    job: typeof pluginJobs.$inferSelect,
    trigger: "schedule" | "manual" | "retry",
    owner: symbol,
    companyId?: string,
  ): Promise<ScopedPluginJobRun[]> {
    const plan = await resolveDispatchPlan(job);
    const companies = selectPluginJobCompanies(plan, trigger, companyId);
    const runs: ScopedPluginJobRun[] = [];
    try {
      for (const company of companies) {
        if (unregisteredPlugins.has(job.pluginId) || jobOwners.get(job.id) !== owner) {
          throw new Error("Job was unregistered during preparation");
        }
        let run: Awaited<ReturnType<typeof jobStore.createRun>>;
        try {
          run = await jobStore.createRun({ jobId: job.id, pluginId: job.pluginId, trigger, companyId: company });
        } catch (insertError) {
          if (typeof insertError === "object" && insertError !== null) runRecordFailures.add(insertError);
          throw insertError;
        }
        runs.push({ id: run.id, companyId: company });
      }
      if (unregisteredPlugins.has(job.pluginId) || jobOwners.get(job.id) !== owner) {
        throw new Error("Job was unregistered during preparation");
      }
      return runs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const run of runs) {
        try {
          await jobStore.completeRun(run.id, { status: "failed", durationMs: 0,
            error: `Not started: creating the run records for this trigger failed: ${message}` });
        } catch (completeErr) {
          log.error({ runId: run.id, err: completeErr instanceof Error ? completeErr.message : String(completeErr) },
            "failed to close an undispatched job run");
        }
      }
      throw error;
    }
  }

  /** True if `promise` settles within `ms`; false otherwise. */
  async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([promise.then(() => true as const), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForTimedOutHandler(
    error: unknown,
    run: ScopedPluginJobRun,
    graceMs: number,
  ): Promise<string | null | undefined> {
    const workerSettled = getTimedOutWorkerSettled(error);
    if (!workerSettled) return undefined;
    if (await settlesWithin(workerSettled, graceMs)) return null;
    return `Not started: the timed-out run ${run.id}` + (run.companyId ? ` for company "${run.companyId}"` : "") +
      ` was still running in the worker ${graceMs}ms after its timeout`;
  }

  async function runPreparedBatch(
    job: typeof pluginJobs.$inferSelect,
    runs: ScopedPluginJobRun[],
    trigger: "schedule" | "manual" | "retry",
    owner: symbol,
  ): Promise<void> {
    const native = isNativeGitHubBoardJobKey(job.jobKey);
    const isCurrent = () => !unregisteredPlugins.has(job.pluginId) && jobOwners.get(job.id) === owner;
    if (native && trigger !== "schedule") throw new Error("Native GitHub board jobs accept scheduled runs only");
    await dispatchPluginJobBatch({ jobKey: job.jobKey, trigger, timeoutMs: jobTimeoutMs,
      scheduledAt: (trigger === "schedule" ? job.nextRunAt ?? new Date() : new Date()).toISOString() }, runs, {
      isCurrent,
      isWorkerRunning: () => native || workerManager.isRunning(job.pluginId),
      isCompanyAuthorized: async (companyId) => {
        const plan = await resolveDispatchPlan(job);
        return plan.scope === "company" && plan.companyIds.includes(companyId);
      },
      markRunning: (runId) => jobStore.markRunning(runId),
      completeRun: (runId, outcome) => jobStore.completeRun(runId, outcome),
      call: (params, timeoutMs) => {
        if (!native) return workerManager.call(job.pluginId, "runJob", params, timeoutMs);
        if (!nativeGitHubProjectBoard) throw new Error("Native board handler disappeared; worker fallback refused");
        return nativeGitHubProjectBoard.run(job, params, timeoutMs, isCurrent);
      },
      isTimeout: (error) => typeof error === "object" && error !== null && "code" in error
        && error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT,
      // A timed-out worker handler may still be running: the next company starts only once it has settled.
      awaitTimedOutHandler: (error, run) => waitForTimedOutHandler(error, run, timedOutRunGraceMs),
    });
  }

  /**
   * Dispatch a single job run — create the run record, call the worker,
   * record the result, and advance the schedule pointer.
   */
  async function dispatchJob(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey });

    const owner = claimJob(jobId, pluginId);
    let runs: ScopedPluginJobRun[] = [];
    const startedAt = Date.now();

    try {
      runs = await prepareRuns(job, "schedule", owner);
      jobLog.info({ runIds: runs.map((run) => run.id) }, "dispatching scheduled job executions");
      await runPreparedBatch(job, runs, "schedule", owner);
      jobLog.info({ durationMs: Date.now() - startedAt }, "scheduled job batch settled; inspect per-company outcomes");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);

      jobLog.error(
        { runIds: runs.map((run) => run.id), durationMs, err: errorMessage },
        "job execution failed",
      );

      // Record the failure
      if (jobOwners.get(jobId) === owner) {
        try {
          // A setup failure has no tenant execution: retain an instance-level diagnostic only.
          if (runs.length === 0 && !(typeof err === "object" && err !== null && runRecordFailures.has(err))) {
            const diagnostic = await jobStore.createRun({ jobId, pluginId, trigger: "schedule" });
            runs = [{ id: diagnostic.id, companyId: null }];
          }
          for (const run of runs) {
            await jobStore.completeRun(run.id, { status: "failed", error: errorMessage, durationMs });
          }
        } catch (completeErr) {
          jobLog.error(
            {
              runIds: runs.map((run) => run.id),
              err: completeErr instanceof Error ? completeErr.message : String(completeErr),
            },
            "failed to record job failure",
          );
        }
      }
    } finally {
      // Remove from active set
      const stillOwned = jobOwners.get(jobId) === owner && !unregisteredPlugins.has(pluginId);
      releaseJob(jobId, owner);

      // Advance on success/failure only while this batch still owned the job.
      try {
        if (stillOwned) await advanceSchedulePointer(job);
      } catch (err) {
        jobLog.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to advance schedule pointer",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  async function assertManualJobAvailable(job: typeof pluginJobs.$inferSelect): Promise<void> {
    const existingRuns = await db.select().from(pluginJobRuns).where(and(
      eq(pluginJobRuns.jobId, job.id), eq(pluginJobRuns.status, "running"),
    ));
    if (existingRuns.length > 0) throw new Error(`Job "${job.jobKey}" already has a running execution`);
    if (!workerManager.isRunning(job.pluginId)) throw new Error(`Worker for plugin "${job.pluginId}" is not running`);
  }

  async function retryCompanyId(
    job: typeof pluginJobs.$inferSelect,
    trigger: "manual" | "retry",
    priorRunId?: string,
  ): Promise<string | undefined> {
    if (priorRunId === undefined) return undefined;
    if (trigger !== "retry") throw new Error("A prior run ID is only accepted for retry dispatch");
    const priorRun = await jobStore.getRunById(priorRunId);
    if (!priorRun || priorRun.jobId !== job.id || priorRun.pluginId !== job.pluginId
      || !["failed", "cancelled"].includes(priorRun.status)) {
      throw new Error("Retry requires a failed or cancelled run of this exact plugin job");
    }
    return priorRun.companyId ?? undefined;
  }

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
    retryRunIdOrOptions?: string | TriggerJobOptions,
  ): Promise<TriggerJobResult> {
    const options: TriggerJobOptions = typeof retryRunIdOrOptions === "string"
      ? { retryRunId: retryRunIdOrOptions } : retryRunIdOrOptions ?? {};
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Reject before claim/createRun, independently of a missing or disabled native handler.
    if (isNativeGitHubBoardJobKey(job.jobKey)) throw new Error("Native GitHub board jobs refuse manual and retry triggers");

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    // Overlap prevention
    if (activeJobs.has(jobId)) {
      throw new Error(
        `Job "${job.jobKey}" is already running — cannot trigger while in progress`,
      );
    }

    // Claim before any further await, including the defensive database check.
    const owner = claimJob(jobId, job.pluginId);
    let dispatched = false;
    try {
      await assertManualJobAvailable(job);
      const retryCompany = await retryCompanyId(job, trigger, options.retryRunId);
      if (retryCompany !== undefined && options.companyId != null && options.companyId !== retryCompany) {
        throw new Error("Retry company differs from the company of the prior run");
      }
      const companyId = retryCompany ?? options.companyId ?? undefined;
      const runs = await prepareRuns(job, trigger, owner, companyId);
      // Dispatch in background — don't block the caller.
      void dispatchManualRun(job, runs, trigger, owner);
      dispatched = true;
      return { runId: runs[0]!.id, jobId, runs: runs.map((run) => ({ runId: run.id, companyId: run.companyId })) };
    } finally {
      if (!dispatched) releaseJob(jobId, owner);
    }
  }

  /**
   * Dispatch a manually triggered job run.
   */
  async function dispatchManualRun(
    job: typeof pluginJobs.$inferSelect,
    runs: ScopedPluginJobRun[],
    trigger: "manual" | "retry",
    owner: symbol,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, runIds: runs.map((run) => run.id), trigger });
    const startedAt = Date.now();

    try {
      await runPreparedBatch(job, runs, trigger, owner);
      jobLog.info({ durationMs: Date.now() - startedAt }, "manual job batch settled; inspect per-company outcomes");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobLog.error({ durationMs, err: errorMessage }, "manual job failed");

      try {
        if (jobOwners.get(jobId) === owner) {
          for (const run of runs) {
            await jobStore.completeRun(run.id, { status: "failed", error: errorMessage, durationMs });
          }
        }
      } catch (completeErr) {
        jobLog.error(
          {
            err: completeErr instanceof Error ? completeErr.message : String(completeErr),
          },
          "failed to record manual job failure",
        );
      }
    } finally {
      releaseJob(jobId, owner);
    }
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the `lastRunAt` and `nextRunAt` timestamps on a job after a run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const now = new Date();
    let nextRunAt: Date | null = null;

    if (job.schedule) {
      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, schedule: job.schedule, error: validationError },
          "invalid cron schedule — cannot compute next run",
        );
      } else {
        const cron = parseCron(job.schedule);
        nextRunAt = nextCronTick(cron, now);
      }
    }

    await jobStore.updateRunTimestamps(job.id, now, nextRunAt);
  }

  /**
   * Ensure one job has a usable `nextRunAt`. A missing or already-past value
   * is recomputed from now (a missed run is skipped, not replayed); a future
   * value is kept. Jobs without a valid cron schedule are left untouched.
   */
  async function ensureNextRunTimestamp(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    // Skip jobs that already have a valid nextRunAt in the future
    if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
      return;
    }

    // Skip jobs without a schedule
    if (!job.schedule) {
      return;
    }

    const validationError = validateCron(job.schedule);
    if (validationError) {
      log.warn(
        { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
        "skipping job with invalid cron schedule",
      );
      return;
    }

    const cron = parseCron(job.schedule);
    const nextRunAt = nextCronTick(cron, new Date());

    if (nextRunAt) {
      await jobStore.updateRunTimestamps(
        job.id,
        job.lastRunAt ?? new Date(0),
        nextRunAt,
      );
      log.debug(
        { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
        "computed nextRunAt for job",
      );
    }
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string, isCurrent: () => boolean): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      if (!isCurrent()) throw new Error("Plugin was unregistered during registration");
      await ensureNextRunTimestamp(job);
    }
  }

  /** Validate the cron and return its next occurrence, or throw. */
  function computeNextRunOrThrow(job: typeof pluginJobs.$inferSelect): Date {
    const schedule = job.schedule as string;
    const validationError = validateCron(schedule);
    if (validationError) {
      throw new PluginJobScheduleError(
        `Job "${job.jobKey}" has an invalid cron schedule: ${validationError}`,
      );
    }
    const next = nextCronTick(parseCron(schedule), new Date());
    if (!next) {
      throw new PluginJobScheduleError(
        `Job "${job.jobKey}" schedule "${schedule}" never produces a next run`,
      );
    }
    return next;
  }

  async function activateJob(jobId: string): Promise<void> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Validate even when a future pointer is retained: the schedule may have
    // changed while the job was paused.
    const next = job.schedule ? computeNextRunOrThrow(job) : undefined;
    const hasFutureRun = !!job.nextRunAt && job.nextRunAt.getTime() > Date.now();
    const nextRunAt = next && !hasFutureRun ? next : undefined;

    await jobStore.updateJobStatus(jobId, "active", nextRunAt ? { nextRunAt } : undefined);
  }

  async function repairActiveJob(jobId: string): Promise<boolean> {
    const job = await jobStore.getJobById(jobId);
    if (!job || job.status !== "active" || job.nextRunAt !== null || !job.schedule) {
      return false;
    }
    const next = computeNextRunOrThrow(job);
    // Conditional write: only if still active with a null pointer.
    return jobStore.armStuckActiveJob(jobId, next);
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    if (unregisterOwners.has(pluginId)) throw new Error("Plugin unregister cleanup is still in progress");
    const revision = pluginRevocations.get(pluginId) ?? 0;
    const isCurrent = () => (pluginRevocations.get(pluginId) ?? 0) === revision;
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId, isCurrent);
    if (!isCurrent() || unregisterOwners.has(pluginId)) throw new Error("Plugin was unregistered during registration");
    unregisteredPlugins.delete(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");
    unregisteredPlugins.add(pluginId);
    pluginRevocations.set(pluginId, (pluginRevocations.get(pluginId) ?? 0) + 1);
    nativeGitHubProjectBoard?.cancelPlugin(pluginId);
    const unregisterOwner = Symbol(pluginId);
    unregisterOwners.set(pluginId, unregisterOwner);

    // Revoke exact current owners synchronously; re-registration cannot revive them.
    for (const [jobId, ownerPlugin] of jobPlugins) {
      if (ownerPlugin !== pluginId) continue;
      jobOwners.delete(jobId);
      jobPlugins.delete(jobId);
      activeJobs.delete(jobId);
    }

    // Cancel any in-flight run records for this plugin that are still
    // queued or running. Active jobs in-memory will finish naturally.
    try {
      const runningRuns = await db
        .select()
        .from(pluginJobRuns)
        .where(
          and(
            eq(pluginJobRuns.pluginId, pluginId),
            or(
              eq(pluginJobRuns.status, "running"),
              eq(pluginJobRuns.status, "queued"),
            ),
          ),
        );

      for (const run of runningRuns) {
        await jobStore.completeRun(run.id, {
          status: "cancelled",
          error: "Plugin unregistered",
          durationMs: run.startedAt
            ? Date.now() - run.startedAt.getTime()
            : null,
        });
      }
    } catch (err) {
      log.error(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "error cancelling in-flight runs during unregister",
      );
    } finally {
      if (unregisterOwners.get(pluginId) === unregisterOwner) unregisterOwners.delete(pluginId);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeJobs.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeJobs.size,
      activeJobIds: [...activeJobs],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    activateJob,
    repairActiveJob,
    triggerJob,
    tick,
    diagnostics,
  };
}
