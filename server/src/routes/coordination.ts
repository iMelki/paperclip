import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  COMPANY_COORDINATION_TASKS_DEFAULT_LIMIT,
  COMPANY_COORDINATION_TASKS_MAX_LIMIT,
  COMPANY_COORDINATION_TASKS_MAX_OFFSET,
  getCompanyCoordinationTasks,
  getIssueCoordination,
  getIssueCoordinationScope,
} from "../services/coordination.js";
import type {
  CompanyCoordinationTaskListOptions,
  TaskCoordinationView,
} from "../services/coordination.js";
import { badRequest } from "../errors.js";
import { assertCompanyAccess, getAccessibleResource } from "./authz.js";

function parseSingleNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== "string") {
    throw badRequest(`${name} must be a single integer`);
  }
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw badRequest(`${name} is too large`);
  }
  return parsed;
}

export function parseCompanyCoordinationPagination(
  query: Request["query"],
): Required<CompanyCoordinationTaskListOptions> {
  const limit = parseSingleNonNegativeInteger(query.limit, "limit")
    ?? COMPANY_COORDINATION_TASKS_DEFAULT_LIMIT;
  const offset = parseSingleNonNegativeInteger(query.offset, "offset") ?? 0;

  if (limit < 1 || limit > COMPANY_COORDINATION_TASKS_MAX_LIMIT) {
    throw badRequest(`limit must be between 1 and ${COMPANY_COORDINATION_TASKS_MAX_LIMIT}`);
  }
  if (offset > COMPANY_COORDINATION_TASKS_MAX_OFFSET) {
    throw badRequest(`offset must be at most ${COMPANY_COORDINATION_TASKS_MAX_OFFSET}`);
  }

  return { limit, offset };
}

function copySafeFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(value, field) ? [[field, value[field]]] : []
  )));
}

function projectPlacement(
  placement: TaskCoordinationView["placements"][number],
): TaskCoordinationView["placements"][number] {
  return {
    hostId: placement.hostId,
    hostname: placement.hostname,
    os: placement.os,
    runtime: placement.runtime,
    ...(placement.reachableAddresses ? { reachableAddresses: [...placement.reachableAddresses] } : {}),
    ...(placement.environment !== undefined ? { environment: placement.environment } : {}),
    ...(placement.nativePath !== undefined ? { nativePath: placement.nativePath } : {}),
    ...(placement.runtimePath !== undefined ? { runtimePath: placement.runtimePath } : {}),
    ...(placement.worktreeIdentity !== undefined ? { worktreeIdentity: placement.worktreeIdentity } : {}),
    repository: placement.repository,
    ...(placement.remoteUrl !== undefined ? { remoteUrl: placement.remoteUrl } : {}),
    branch: placement.branch,
    ...(placement.baseSha !== undefined ? { baseSha: placement.baseSha } : {}),
    ...(placement.headSha !== undefined ? { headSha: placement.headSha } : {}),
    dirty: placement.dirty,
    ...(placement.aheadCount !== undefined ? { aheadCount: placement.aheadCount } : {}),
    ...(placement.behindCount !== undefined ? { behindCount: placement.behindCount } : {}),
    ...(placement.processId !== undefined ? { processId: placement.processId } : {}),
    ...(placement.processGroup !== undefined ? { processGroup: placement.processGroup } : {}),
    ...(placement.serviceReferences ? { serviceReferences: [...placement.serviceReferences] } : {}),
    ...(placement.logReferences ? { logReferences: [...placement.logReferences] } : {}),
  };
}

function projectCoordinationView(
  view: TaskCoordinationView,
  disclosure: "exact" | "observer",
): TaskCoordinationView {
  if (view.schemaVersion !== "task-coordination.v1") {
    throw new Error(`Unsupported task coordination schema version: ${String(view.schemaVersion)}`);
  }

  const exact = disclosure === "exact";
  return {
    schemaVersion: view.schemaVersion,
    task: {
      canonicalKey: view.task.canonicalKey,
      githubProjectItemId: view.task.githubProjectItemId,
      mckTaskId: view.task.mckTaskId,
      paperclipParentIssueId: view.task.paperclipParentIssueId,
      correlationId: view.task.correlationId,
      status: view.task.status,
      accountableLead: view.task.accountableLead,
      generation: view.task.generation,
      createdAt: view.task.createdAt,
      updatedAt: view.task.updatedAt,
    },
    workUnits: view.workUnits.map((workUnit) => ({
      id: workUnit.id,
      paperclipChildIssueId: workUnit.paperclipChildIssueId,
      githubChildIssueId: workUnit.githubChildIssueId,
      owner: workUnit.owner,
      acceptanceCriteria: [...workUnit.acceptanceCriteria],
      ...(workUnit.tests ? { tests: [...workUnit.tests] } : {}),
      mutationScope: {
        repositories: [...workUnit.mutationScope.repositories],
        paths: exact ? [...workUnit.mutationScope.paths] : [],
      },
      state: workUnit.state,
    })),
    participants: view.participants.map((participant) => ({
      id: participant.id,
      runtime: participant.runtime,
      role: participant.role,
      mode: participant.mode,
      enforcementMode: participant.enforcementMode,
      runId: exact ? participant.runId : null,
      sessionId: exact ? participant.sessionId : null,
      currentAction: exact ? participant.currentAction : null,
      progressNote: exact ? participant.progressNote : null,
      blocker: exact ? participant.blocker : null,
      nextAction: exact ? participant.nextAction : null,
      retryState: exact ? participant.retryState : null,
      startedAt: participant.startedAt,
      lastSeenAt: participant.lastSeenAt,
      endedAt: participant.endedAt,
    })),
    placements: exact ? view.placements.map(projectPlacement) : [],
    delivery: {
      commits: [...view.delivery.commits],
      pullRequests: view.delivery.pullRequests.map((pullRequest) => ({
        number: pullRequest.number,
        url: pullRequest.url,
        headBranch: pullRequest.headBranch,
        baseBranch: pullRequest.baseBranch,
        status: pullRequest.status,
        ...(exact && pullRequest.checks ? { checks: pullRequest.checks.map((check) => ({ ...check })) } : {}),
        ...(exact && pullRequest.receipt !== undefined
          ? { receipt: pullRequest.receipt ? { ...pullRequest.receipt } : null }
          : {}),
      })),
    },
    health: {
      heartbeatAgeSeconds: view.health.heartbeatAgeSeconds,
      ...(view.health.processEvidence !== undefined ? { processEvidence: view.health.processEvidence } : {}),
      ...(view.health.outputEvidence !== undefined ? { outputEvidence: view.health.outputEvidence } : {}),
      status: view.health.status,
      freshnessTimestamp: view.health.freshnessTimestamp,
      evidenceSource: view.health.evidenceSource,
    },
    controls: {
      permittedIntents: [...view.controls.permittedIntents],
      pendingIntents: view.controls.pendingIntents.map((intent) => copySafeFields(
        intent,
        ["id", "intentType", "targetWorkUnitId", "requestedBy", "createdAt"],
      )),
      completedReceipts: view.controls.completedReceipts.map((receipt) => copySafeFields(
        receipt,
        exact
          ? ["id", "intentType", "receipt", "executedAt"]
          : ["id", "intentType", "executedAt"],
      )),
    },
    provenance: {
      sourceAuthority: view.provenance.sourceAuthority,
      observedAt: view.provenance.observedAt,
      confidence: view.provenance.confidence,
      reconciliationDrift: view.provenance.reconciliationDrift,
      ...(view.provenance.driftDetails
        ? {
          driftDetails: exact
            ? [...view.provenance.driftDetails]
            : ["Detailed reconciliation drift is restricted to the accountable task team."],
        }
        : {}),
    },
  };
}

function redactObserverSensitiveCoordination(view: TaskCoordinationView): TaskCoordinationView {
  return projectCoordinationView(view, "observer");
}

function projectExactCoordination(view: TaskCoordinationView): TaskCoordinationView {
  return projectCoordinationView(view, "exact");
}

/*
 * Coordination views can contain host addresses, local paths, process ids,
 * logs, and runtime receipts. They must never be stored in a shared browser or
 * intermediary cache, even when the caller is authorized for the exact DTO.
 */
function setCoordinationNoStore(_req: unknown, res: { set: (field: string, value: string) => unknown }, next: () => void) {
  res.set("Cache-Control", "no-store");
  next();
}

export function coordinationRoutes(db: Db) {
  const router = Router();

  router.use(setCoordinationNoStore);

  router.get("/companies/:companyId/coordination/tasks", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const pagination = parseCompanyCoordinationPagination(req.query);
      const tasks = await getCompanyCoordinationTasks(db, companyId, pagination);
      res.json(tasks.map(req.actor.type === "board"
        ? projectExactCoordination
        : redactObserverSensitiveCoordination));
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:rootIssueId/coordination", async (req, res, next) => {
    try {
      const rootIssueId = req.params.rootIssueId as string;
      const scope = await getAccessibleResource(
        req,
        res,
        getIssueCoordinationScope(db, rootIssueId),
        "Root issue not found",
      );
      if (!scope) return;
      const resource = await getIssueCoordination(db, rootIssueId, scope.companyId);
      if (!resource || resource.companyId !== scope.companyId) {
        res.status(404).json({ error: "Root issue not found" });
        return;
      }
      const mayViewExactPlacement = req.actor.type === "board"
        || (req.actor.type === "agent"
          && typeof req.actor.agentId === "string"
          && (resource.placementViewerAgentIds ?? []).includes(req.actor.agentId));
      res.json(mayViewExactPlacement
        ? projectExactCoordination(resource.view)
        : redactObserverSensitiveCoordination(resource.view));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
