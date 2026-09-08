import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { HireApprovedPayload } from "@paperclipai/adapter-utils";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Paperclip or ask you to create issues.";

export interface NotifyHireApprovedInput {
  companyId: string;
  agentId: string;
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt?: Date;
}

const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1000;

interface PendingNotificationJob {
  input: NotifyHireApprovedInput;
  attempts: number;
  nextAttemptAt: number;
}

const pendingNotificationQueue: PendingNotificationJob[] = [];
let queueProcessing = false;

export function queueDurableHireNotification(input: NotifyHireApprovedInput): void {
  pendingNotificationQueue.push({
    input,
    attempts: 0,
    nextAttemptAt: Date.now(),
  });
}

export async function processPendingHireNotifications(db: Db): Promise<{ processed: number; succeeded: number; failed: number }> {
  if (queueProcessing) return { processed: 0, succeeded: 0, failed: 0 };
  queueProcessing = true;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    const now = Date.now();
    for (let i = pendingNotificationQueue.length - 1; i >= 0; i--) {
      const job = pendingNotificationQueue[i];
      if (job.nextAttemptAt > now) continue;

      processed++;
      job.attempts++;
      try {
        await notifyHireApproved(db, job.input);
        succeeded++;
        pendingNotificationQueue.splice(i, 1);
      } catch (err) {
        failed++;
        if (job.attempts >= MAX_DELIVERY_ATTEMPTS) {
          logger.error(
            { err, input: job.input, attempts: job.attempts },
            "hire hook: notification dropped after maximum retry attempts",
          );
          pendingNotificationQueue.splice(i, 1);
        } else {
          job.nextAttemptAt = Date.now() + BASE_RETRY_DELAY_MS * Math.pow(2, job.attempts);
        }
      }
    }
  } finally {
    queueProcessing = false;
  }

  return { processed, succeeded, failed };
}

export function getPendingNotificationQueueSize(): number {
  return pendingNotificationQueue.length;
}

/**
 * Invokes the adapter's onHireApproved hook when an agent is approved (join-request or hire_agent approval).
 * Failures are non-fatal: we log and write to activity, never throw.
 */
export async function notifyHireApproved(
  db: Db,
  input: NotifyHireApprovedInput,
): Promise<void> {
  const { companyId, agentId, source, sourceId } = input;
  const approvedAt = input.approvedAt ?? new Date();

  const row = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    logger.warn({ companyId, agentId, source, sourceId }, "hire hook: agent not found in company, skipping");
    return;
  }

  const adapterType = row.adapterType ?? "process";
  const adapter = findActiveServerAdapter(adapterType);
  const onHireApproved = adapter?.onHireApproved;
  if (!onHireApproved) {
    return;
  }

  const payload: HireApprovedPayload = {
    companyId,
    agentId,
    agentName: row.name,
    adapterType,
    source,
    sourceId,
    approvedAt: approvedAt.toISOString(),
    message: HIRE_APPROVED_MESSAGE,
  };

  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? (row.adapterConfig as Record<string, unknown>)
      : {};

  try {
    const result = await onHireApproved(payload, adapterConfig);
    if (result.ok) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.succeeded",
        entityType: "agent",
        entityId: agentId,
        details: { source, sourceId, adapterType },
      });
      return;
    }

    logger.warn(
      { companyId, agentId, adapterType, source, sourceId, error: result.error, detail: result.detail },
      "hire hook: adapter returned failure",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.failed",
      entityType: "agent",
      entityId: agentId,
      details: { source, sourceId, adapterType, error: result.error, detail: result.detail },
    });
  } catch (err) {
    logger.error(
      { err, companyId, agentId, adapterType, source, sourceId },
      "hire hook: adapter threw",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.error",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        adapterType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
