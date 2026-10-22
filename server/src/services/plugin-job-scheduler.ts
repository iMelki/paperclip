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
 *    captured. A job declared `scope: "company"` gets one row per configured
 *    company (with that `company_id`), each with its own run id and dispatched
 *    sequentially with that company's invocation scope. Instance-scoped jobs
 *    (the default) keep one row per trigger.
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
import type { PluginJobRunTrigger } from "@paperclipai/shared";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";

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
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /** The first created run ID (the only one for an instance-scoped job). */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
  /**
   * Every created run, in execution order. A company-scoped job gets one run
   * per configured company, each with its own run ID and company ID.
   */
  runs: Array<{ runId: string; companyId: string | null }>;
}

/** A run record created for one target of a job trigger. */
interface PlannedRun {
  runId: string;
  companyId: string | null;
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
    options?: TriggerJobOptions,
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
  } = options;

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
        if (!workerManager.isRunning(job.pluginId)) {
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
  // Core: run targets (instance run, or one run per company)
  // -----------------------------------------------------------------------

  /**
   * Resolve the run targets for one trigger of a job.
   *
   * - Instance-scoped jobs (the default, including jobs that declare no
   *   scope) run once: `[null]`.
   * - Company-scoped jobs (`scope: "company"` in the manifest) run once per
   *   host-authorized configured company, in sorted order. With no configured
   *   company they run once unscoped, as before.
   * - `onlyCompanyId` restricts a company-scoped job to one configured
   *   company (per-company manual trigger or retry).
   */
  async function resolveRunTargets(
    job: typeof pluginJobs.$inferSelect,
    onlyCompanyId?: string | null,
  ): Promise<Array<string | null>> {
    const scope = await jobStore.getJobDeclarationScope(job.pluginId, job.jobKey);
    if (scope !== "company") {
      if (onlyCompanyId) {
        throw new Error(
          `Job "${job.jobKey}" is instance-scoped and cannot be triggered for one company`,
        );
      }
      return [null];
    }
    const companyIds = [...workerManager.getProactiveCompanyScopes(job.pluginId)].sort();
    if (onlyCompanyId) {
      if (!companyIds.includes(onlyCompanyId)) {
        throw new Error(
          `Company "${onlyCompanyId}" has not configured plugin "${job.pluginId}" (job "${job.jobKey}")`,
        );
      }
      return [onlyCompanyId];
    }
    return companyIds.length > 0 ? companyIds : [null];
  }

  /** Create one queued run record per target, each with its own run id. */
  async function createRuns(
    job: typeof pluginJobs.$inferSelect,
    trigger: PluginJobRunTrigger,
    targets: Array<string | null>,
  ): Promise<PlannedRun[]> {
    const planned: PlannedRun[] = [];
    for (const companyId of targets) {
      const run = await jobStore.createRun({
        jobId: job.id,
        pluginId: job.pluginId,
        trigger,
        companyId,
      });
      planned.push({ runId: run.id, companyId });
    }
    return planned;
  }

  /**
   * Execute planned runs sequentially. Each run is marked running, dispatched
   * with its own run id (and, for a company run, its host-chosen company id),
   * and completed. A failure in one company's run does not stop the others.
   *
   * @returns the number of runs that did not succeed
   */
  async function executeRuns(
    job: typeof pluginJobs.$inferSelect,
    trigger: PluginJobRunTrigger,
    scheduledAt: string,
    planned: PlannedRun[],
  ): Promise<number> {
    const { id: jobId, pluginId, jobKey } = job;
    let failures = 0;

    for (const { runId, companyId } of planned) {
      const runLog = log.child({ jobId, pluginId, jobKey, runId, trigger, companyId });
      const startedAt = Date.now();
      try {
        await jobStore.markRunning(runId);
        runLog.info("dispatching job run");

        await workerManager.call(
          pluginId,
          "runJob",
          {
            job: {
              jobKey,
              runId,
              trigger,
              scheduledAt,
              ...(companyId ? { companyId } : {}),
            },
            ...(companyId ? { companyId } : {}),
          },
          jobTimeoutMs,
        );

        const durationMs = Date.now() - startedAt;
        await jobStore.completeRun(runId, { status: "succeeded", durationMs });
        runLog.info({ durationMs }, "job run completed successfully");
      } catch (err) {
        failures++;
        const durationMs = Date.now() - startedAt;
        const errorMessage = err instanceof Error ? err.message : String(err);
        runLog.error({ durationMs, err: errorMessage }, "job run failed");
        try {
          await jobStore.completeRun(runId, {
            status: "failed",
            error: errorMessage,
            durationMs,
          });
        } catch (completeErr) {
          runLog.error(
            {
              err: completeErr instanceof Error ? completeErr.message : String(completeErr),
            },
            "failed to record job run failure",
          );
        }
      }
    }

    return failures;
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a scheduled job
  // -----------------------------------------------------------------------

  /**
   * Dispatch one scheduled trigger of a job: create the run record(s), call
   * the worker, record each result, and advance the schedule pointer.
   */
  async function dispatchJob(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey });

    // Mark as active (overlap prevention)
    activeJobs.add(jobId);

    try {
      const targets = await resolveRunTargets(job);
      const planned = await createRuns(job, "schedule", targets);
      jobLog.info({ runCount: planned.length }, "dispatching scheduled job");
      await executeRuns(
        job,
        "schedule",
        (job.nextRunAt ?? new Date()).toISOString(),
        planned,
      );
    } catch (err) {
      jobLog.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduled job dispatch failed",
      );
    } finally {
      // Remove from active set
      activeJobs.delete(jobId);

      // Always advance the schedule pointer (even on failure)
      try {
        await advanceSchedulePointer(job);
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

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
    options: TriggerJobOptions = {},
  ): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

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

    // Also check DB for running runs (defensive — covers multi-instance)
    const existingRuns = await db
      .select()
      .from(pluginJobRuns)
      .where(
        and(
          eq(pluginJobRuns.jobId, jobId),
          eq(pluginJobRuns.status, "running"),
        ),
      );

    if (existingRuns.length > 0) {
      throw new Error(
        `Job "${job.jobKey}" already has a running execution — cannot trigger while in progress`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    // Create the run(s) and dispatch (non-blocking)
    const targets = await resolveRunTargets(job, options.companyId ?? null);
    const planned = await createRuns(job, trigger, targets);

    // Dispatch in background — don't block the caller
    void dispatchManualRun(job, planned, trigger);

    return {
      runId: planned[0]!.runId,
      jobId,
      runs: planned.map(({ runId, companyId }) => ({ runId, companyId })),
    };
  }

  /**
   * Dispatch a manually triggered job's planned run(s).
   */
  async function dispatchManualRun(
    job: typeof pluginJobs.$inferSelect,
    planned: PlannedRun[],
    trigger: "manual" | "retry",
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, trigger });

    activeJobs.add(jobId);
    try {
      const failures = await executeRuns(job, trigger, new Date().toISOString(), planned);
      jobLog.info(
        { runCount: planned.length, failedRunCount: failures },
        "manual job finished",
      );
    } catch (err) {
      jobLog.error(
        { err: err instanceof Error ? err.message : String(err) },
        "manual job dispatch failed",
      );
    } finally {
      activeJobs.delete(jobId);
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
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // Skip jobs that already have a valid nextRunAt in the future
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
        continue;
      }

      // Skip jobs without a schedule
      if (!job.schedule) {
        continue;
      }

      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
          "skipping job with invalid cron schedule",
        );
        continue;
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
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");

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
    }

    // Remove any active tracking for jobs owned by this plugin
    const jobs = await jobStore.listJobs(pluginId);
    for (const job of jobs) {
      activeJobs.delete(job.id);
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
    triggerJob,
    tick,
    diagnostics,
  };
}
