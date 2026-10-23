import { createPluginJobEnvelope, type PluginJobTrigger } from "./plugin-job-scope.js";

export interface ScopedPluginJobRun { id: string; companyId: string | null }
interface RunOutcome { status: "succeeded" | "failed" | "cancelled"; error?: string; durationMs: number }
export interface PluginJobBatchPorts {
  isCurrent(): boolean;
  isWorkerRunning(): boolean;
  isCompanyAuthorized(companyId: string): Promise<boolean>;
  markRunning(runId: string): Promise<void>;
  completeRun(runId: string, outcome: RunOutcome): Promise<void>;
  call(params: ReturnType<typeof createPluginJobEnvelope>, timeoutMs: number): Promise<unknown>;
  isTimeout(error: unknown): boolean;
  now?(): number;
}

/** Sequential fan-out, with one total RPC time budget and no detached company work. */
export async function dispatchPluginJobBatch(
  input: { jobKey: string; trigger: PluginJobTrigger; scheduledAt: string; timeoutMs: number },
  runs: readonly ScopedPluginJobRun[],
  ports: PluginJobBatchPorts,
): Promise<void> {
  const now = ports.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  let stoppedReason: string | undefined;
  for (const run of runs) {
    if (!ports.isCurrent()) return; // Unregister owns cancellation; do not overwrite terminal rows.
    if (!ports.isWorkerRunning()) stoppedReason = "Worker unavailable; remaining company executions deferred";
    if (now() >= deadline) stoppedReason = "Job batch time budget exhausted; remaining company executions deferred";
    if (stoppedReason) {
      await ports.completeRun(run.id, { status: "cancelled", error: stoppedReason, durationMs: 0 });
      continue;
    }
    const startedAt = now();
    let outcome: RunOutcome;
    try {
      if (run.companyId !== null && !(await ports.isCompanyAuthorized(run.companyId))) {
        throw new Error("Company is no longer authorized for this job; execution refused");
      }
      if (!ports.isCurrent()) return;
      if (!ports.isWorkerRunning() || now() >= deadline) {
        stoppedReason = "Worker or job batch deadline changed before dispatch; execution deferred";
        throw new Error(stoppedReason);
      }
      await ports.markRunning(run.id);
      if (!ports.isCurrent()) return;
      if (now() >= deadline) {
        stoppedReason = "Job batch deadline reached before RPC; execution deferred";
        throw new Error(stoppedReason);
      }
      await ports.call(createPluginJobEnvelope(input.jobKey, run.id, input.trigger,
        input.scheduledAt, run.companyId), Math.max(1, deadline - now()));
      outcome = { status: "succeeded", durationMs: now() - startedAt };
    } catch (error) {
      if (!ports.isCurrent()) return;
      outcome = { status: stoppedReason ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error),
        durationMs: now() - startedAt };
      if (ports.isTimeout(error)) stoppedReason = "Earlier company RPC timed out; remaining company executions deferred";
    }
    if (ports.isCurrent()) await ports.completeRun(run.id, outcome);
  }
}
