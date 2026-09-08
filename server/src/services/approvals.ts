import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import {
  enforceHireApprovalPermissionBoundary,
  prepareNormalizedHireApprovalPayloadForPersistence,
  restoreHireApprovalPayloadFromPendingAgent,
} from "./hire-approval-payload.js";
import { notifyHireApproved, queueDurableHireNotification } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { secretService } from "./secrets.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const instanceSettings = instanceSettingsService(db);
  const secretsSvc = secretService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function reconcileApprovedBuiltInAgent(
    source: Db,
    companyId: string,
    payload: Record<string, unknown>,
  ) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string"
      ? payload.sourceBuiltInAgentKey
      : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(source).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function getExistingApproval(id: string, source: Db = db) {
    const existing = await source
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    source: Db = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, source);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await source
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, source);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  async function prepareHirePayloadForPersistence(
    companyId: string,
    payload: Record<string, unknown>,
    options?: { strictMode?: boolean },
  ) {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    let pendingAgent: Awaited<ReturnType<typeof agentsSvc.getById>> | null = null;
    let materializedPayload = payload;

    if (agentId) {
      pendingAgent = await agentsSvc.getById(agentId);
      if (
        !pendingAgent
        || pendingAgent.companyId !== companyId
        || pendingAgent.status !== "pending_approval"
      ) {
        throw unprocessable("Hire approval requires a pending agent in the same company", {
          code: "hire_approval_pending_agent_mismatch",
          companyId,
          agentId,
        });
      }
      materializedPayload = restoreHireApprovalPayloadFromPendingAgent(
        payload,
        pendingAgent as unknown as Record<string, unknown>,
      );
    }

    const normalizedPayload = await secretsSvc.normalizeHireApprovalPayloadForPersistence(
      companyId,
      materializedPayload,
      options,
    );
    const persistedPayload = prepareNormalizedHireApprovalPayloadForPersistence(
      normalizedPayload,
      pendingAgent as unknown as Record<string, unknown> | null,
    );
    return enforceHireApprovalPermissionBoundary(
      persistedPayload,
      pendingAgent as unknown as Record<string, unknown> | null,
    );
  }

  async function activateApprovedPendingAgent(
    source: Db,
    approval: ApprovalRecord,
    payload: Record<string, unknown>,
    agentId: string,
  ) {
    const scopedAgents = agentService(source);
    const pendingAgent = await scopedAgents.getById(agentId);
    if (
      !pendingAgent
      || pendingAgent.companyId !== approval.companyId
      || pendingAgent.status !== "pending_approval"
    ) {
      throw unprocessable("Hire approval requires a pending agent in the same company", {
        code: "hire_approval_pending_agent_mismatch",
        approvalId: approval.id,
        agentId,
      });
    }
    const restoredPayload = restoreHireApprovalPayloadFromPendingAgent(
      payload,
      pendingAgent as unknown as Record<string, unknown>,
    );
    const guardedPayload = enforceHireApprovalPermissionBoundary(
      restoredPayload,
      pendingAgent as unknown as Record<string, unknown>,
    );
    const activation = await scopedAgents.activatePendingApproval(agentId, guardedPayload);
    if (activation?.activated) return activation.agent.id;
    throw unprocessable("Hire approval could not activate the pending agent", {
      code: "hire_approval_activation_not_applied",
      approvalId: approval.id,
      agentId,
    });
  }

  async function createAgentFromApprovedHire(
    source: Db,
    approval: ApprovalRecord,
    payload: Record<string, unknown>,
  ) {
    const guardedPayload = enforceHireApprovalPermissionBoundary(payload);
    const created = await agentService(source).create(approval.companyId, {
      name: String(guardedPayload.name ?? "New Agent"),
      role: String(guardedPayload.role ?? "general"),
      title: typeof guardedPayload.title === "string" ? guardedPayload.title : null,
      icon: typeof guardedPayload.icon === "string" ? guardedPayload.icon : null,
      reportsTo: typeof guardedPayload.reportsTo === "string" ? guardedPayload.reportsTo : null,
      capabilities: typeof guardedPayload.capabilities === "string" ? guardedPayload.capabilities : null,
      adapterType: String(guardedPayload.adapterType ?? "process"),
      adapterConfig:
        typeof guardedPayload.adapterConfig === "object" && guardedPayload.adapterConfig !== null
          ? (guardedPayload.adapterConfig as Record<string, unknown>)
          : {},
      runtimeConfig:
        typeof guardedPayload.runtimeConfig === "object"
          && guardedPayload.runtimeConfig !== null
          && !Array.isArray(guardedPayload.runtimeConfig)
          ? (guardedPayload.runtimeConfig as Record<string, unknown>)
          : {},
      defaultEnvironmentId:
        typeof guardedPayload.defaultEnvironmentId === "string"
          ? guardedPayload.defaultEnvironmentId
          : null,
      budgetMonthlyCents:
        typeof guardedPayload.budgetMonthlyCents === "number"
          ? guardedPayload.budgetMonthlyCents
          : 0,
      metadata:
        typeof guardedPayload.metadata === "object"
          && guardedPayload.metadata !== null
          && !Array.isArray(guardedPayload.metadata)
          ? (guardedPayload.metadata as Record<string, unknown>)
          : null,
      status: "idle",
      spentMonthlyCents: 0,
      permissions:
        typeof guardedPayload.permissions === "object"
          && guardedPayload.permissions !== null
          && !Array.isArray(guardedPayload.permissions)
          ? (guardedPayload.permissions as Record<string, unknown>)
          : undefined,
      lastHeartbeatAt: null,
    });
    if (created?.id) return created.id;
    throw unprocessable("Hire approval did not produce an agent", {
      code: "hire_approval_agent_missing",
      approvalId: approval.id,
    });
  }

  async function applyApprovedHire(
    source: Db,
    approval: ApprovalRecord,
    decidedByUserId: string,
  ) {
    const payload = approval.payload as Record<string, unknown>;
    const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
    const hireApprovedAgentId = payloadAgentId
      ? await activateApprovedPendingAgent(source, approval, payload, payloadAgentId)
      : await createAgentFromApprovedHire(source, approval, payload);

    await reconcileApprovedBuiltInAgent(source, approval.companyId, payload);
    const budgetMonthlyCents =
      typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
    if (budgetMonthlyCents > 0) {
      await budgetService(source).upsertPolicy(
        approval.companyId,
        {
          scopeType: "agent",
          scopeId: hireApprovedAgentId,
          amount: budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        decidedByUserId,
      );
    }

    return {
      companyId: approval.companyId,
      agentId: hireApprovedAgentId,
      source: "approval" as const,
      sourceId: approval.id,
      approvedAt: approval.decidedAt ?? new Date(),
    };
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: async (
      companyId: string,
      data: Omit<typeof approvals.$inferInsert, "companyId">,
      options?: { strictMode?: boolean },
    ) => {
      const payload = data.type === "hire_agent"
        ? await prepareHirePayloadForPersistence(companyId, data.payload, options)
        : data.payload;
      return db
        .insert(approvals)
        .values({ ...data, companyId, payload })
        .returning()
        .then((rows) => rows[0]);
    },

    prepareHirePayloadForPersistence,

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null) => {
      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "cancelled",
          decisionNote: reason ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated;
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const transactionResult = await db.transaction(async (tx) => {
        const source = tx as unknown as Db;
        const resolution = await resolveApproval(
          id,
          "approved",
          decidedByUserId,
          decisionNote,
          source,
        );
        const notification = resolution.applied && resolution.approval.type === "hire_agent"
          ? await applyApprovedHire(source, resolution.approval, decidedByUserId)
          : null;
        return { ...resolution, notification };
      });

      if (transactionResult.notification) {
        queueDurableHireNotification(transactionResult.notification);
        void notifyHireApproved(db, transactionResult.notification).catch(() => {});
      }
      return {
        approval: transactionResult.approval,
        applied: transactionResult.applied,
      };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning()
        .then((rows) => {
          const updated = rows[0] ?? null;
          if (!updated) {
            throw unprocessable("Approval state changed before revision could be requested", {
              code: "approval_revision_request_not_applied",
              approvalId: id,
            });
          }
          return updated;
        });
    },

    resubmit: async (
      id: string,
      payload?: Record<string, unknown>,
      options?: { strictMode?: boolean },
    ) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const persistedPayload = payload && existing.type === "hire_agent"
        ? await prepareHirePayloadForPersistence(existing.companyId, payload, options)
        : payload ?? existing.payload;
      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: persistedPayload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "revision_requested")))
        .returning()
        .then((rows) => {
          const updated = rows[0] ?? null;
          if (!updated) {
            throw unprocessable("Approval state changed before resubmission could be applied", {
              code: "approval_resubmit_not_applied",
              approvalId: id,
            });
          }
          return updated;
        });
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
