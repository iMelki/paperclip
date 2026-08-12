import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  taskParticipations,
  mutationLeases,
  controlIntents,
  agentInstances,
  hostNodes,
} from "@paperclipai/db";

export interface TaskCoordinationView {
  schemaVersion: "task-coordination.v1";
  task: {
    canonicalKey: string;
    githubProjectItemId: string | null;
    mckTaskId: string | null;
    paperclipParentIssueId: string | null;
    correlationId: string;
    status: "open" | "in_progress" | "blocked" | "under_review" | "completed" | "cancelled";
    accountableLead: string;
    generation: number;
    createdAt: string;
    updatedAt: string;
  };
  workUnits: Array<{
    id: string;
    paperclipChildIssueId: string | null;
    githubChildIssueId: string | null;
    owner: string;
    acceptanceCriteria: string[];
    tests?: string[];
    mutationScope: {
      repositories: string[];
      paths: string[];
    };
    state: "pending" | "in_progress" | "submitted" | "approved" | "failed";
  }>;
  participants: Array<{
    id: string;
    runtime: string;
    role: "lead" | "worker" | "reviewer" | "helper";
    mode: "mutate" | "read" | "review";
    enforcementMode: "observe" | "enforce_mutations";
    runId: string | null;
    sessionId: string | null;
    currentAction: string | null;
    progressNote: string | null;
    blocker: string | null;
    nextAction: string | null;
    retryState: Record<string, unknown> | null;
    startedAt: string;
    lastSeenAt: string;
    endedAt: string | null;
  }>;
  placements: Array<{
    hostId: string;
    hostname: string;
    os: string;
    runtime: string;
    reachableAddresses?: string[];
    environment?: string;
    nativePath?: string;
    runtimePath?: string;
    worktreeIdentity?: string;
    repository: string;
    remoteUrl?: string;
    branch: string;
    baseSha?: string;
    headSha?: string;
    dirty: boolean;
    aheadCount?: number;
    behindCount?: number;
    processId?: number | null;
    processGroup?: string | null;
    serviceReferences?: string[];
    logReferences?: string[];
  }>;
  delivery: {
    commits: string[];
    pullRequests: Array<{
      number: number;
      url: string;
      headBranch: string;
      baseBranch: string;
      status: "open" | "draft" | "merged" | "closed";
      checks?: Record<string, unknown>[];
      receipt?: Record<string, unknown> | null;
    }>;
  };
  health: {
    heartbeatAgeSeconds: number;
    processEvidence?: boolean;
    outputEvidence?: boolean;
    status: "healthy" | "reporting_degraded" | "stale" | "orphaned" | "error" | "offline";
    freshnessTimestamp: string;
    evidenceSource: string;
  };
  controls: {
    permittedIntents: Array<"pause" | "cancel" | "retry" | "release" | "reassign" | "takeover">;
    pendingIntents: Record<string, unknown>[];
    completedReceipts: Record<string, unknown>[];
  };
  provenance: {
    sourceAuthority: "paperclip" | "mck" | "github" | "mission-control";
    observedAt: string;
    confidence: number;
    reconciliationDrift: boolean;
    driftDetails?: string[];
  };
}

function mapIssueStatusToTaskStatus(
  status: string,
): "open" | "in_progress" | "blocked" | "under_review" | "completed" | "cancelled" {
  switch (status) {
    case "todo":
    case "backlog":
    case "open":
      return "open";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "in_review":
    case "under_review":
      return "under_review";
    case "done":
    case "completed":
      return "completed";
    case "cancelled":
    case "closed":
      return "cancelled";
    default:
      return "open";
  }
}

function mapIssueStatusToWorkUnitState(
  status: string,
): "pending" | "in_progress" | "submitted" | "approved" | "failed" {
  switch (status) {
    case "todo":
    case "backlog":
    case "open":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "in_review":
    case "under_review":
      return "submitted";
    case "done":
    case "completed":
      return "approved";
    case "cancelled":
    case "blocked":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Resolve only the company scope needed to authorize a coordination-detail
 * read. Route handlers must authorize this result before calling
 * getIssueCoordination, because the full view includes work descriptions,
 * participant state, host topology, and control receipts.
 */
export async function getIssueCoordinationRootScope(
  db: Db,
  rootIssueId: string,
): Promise<{ companyId: string } | null> {
  return db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, rootIssueId))
    .then((rows) => rows[0] ?? null);
}

export async function getIssueCoordination(
  db: Db,
  rootIssueId: string,
  companyId: string,
): Promise<TaskCoordinationView | null> {
  const rootIssue = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!rootIssue) {
    return null;
  }

  // Fetch child issues / work units
  const childIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.parentId, rootIssueId), eq(issues.companyId, companyId)));

  const allIssueIds = [rootIssue.id, ...childIssues.map((c) => c.id)];

  // Fetch participations, leases, intents
  const participations = await db
    .select()
    .from(taskParticipations)
    .where(and(
      inArray(taskParticipations.issueId, allIssueIds),
      eq(taskParticipations.companyId, companyId),
    ));

  const leases = await db
    .select()
    .from(mutationLeases)
    .where(and(
      inArray(mutationLeases.issueId, allIssueIds),
      eq(mutationLeases.companyId, companyId),
    ));

  const intents = await db
    .select()
    .from(controlIntents)
    .where(and(
      eq(controlIntents.rootIssueId, rootIssue.id),
      eq(controlIntents.companyId, companyId),
    ));

  // Fetch agent instances and host nodes
  const agentInstanceIds = [
    ...new Set(
      participations
        .map((p) => p.agentInstanceId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  const instances = agentInstanceIds.length > 0
    ? await db.select().from(agentInstances).where(and(
      inArray(agentInstances.id, agentInstanceIds),
      eq(agentInstances.companyId, companyId),
    ))
    : [];

  const hostNodeIds = [
    ...new Set(
      instances
        .map((i) => i.hostNodeId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  const hosts = hostNodeIds.length > 0
    ? await db.select().from(hostNodes).where(and(
      inArray(hostNodes.id, hostNodeIds),
      eq(hostNodes.companyId, companyId),
    ))
    : [];

  const now = new Date();
  const mostRecentSeen = participations.reduce<Date>((latest, p) => {
    const t = new Date(p.lastSeenAt);
    return t > latest ? t : latest;
  }, new Date(rootIssue.updatedAt));

  const heartbeatAgeSeconds = Math.max(0, Math.floor((now.getTime() - mostRecentSeen.getTime()) / 1000));

  let healthStatus: "healthy" | "reporting_degraded" | "stale" | "orphaned" | "error" | "offline" = "healthy";
  if (heartbeatAgeSeconds > 1800) {
    healthStatus = "orphaned";
  } else if (heartbeatAgeSeconds > 300) {
    healthStatus = "stale";
  }

  const canonicalKey = rootIssue.identifier
    ? `github:${rootIssue.identifier}`
    : `github:paperclip/issue#${rootIssue.issueNumber}`;

  return {
    schemaVersion: "task-coordination.v1",
    task: {
      canonicalKey,
      githubProjectItemId: null,
      mckTaskId: null,
      paperclipParentIssueId: rootIssue.id,
      correlationId: rootIssue.id,
      status: mapIssueStatusToTaskStatus(rootIssue.status),
      accountableLead: rootIssue.assigneeAgentId ?? "unassigned",
      generation: 1,
      createdAt: rootIssue.createdAt.toISOString(),
      updatedAt: rootIssue.updatedAt.toISOString(),
    },
    workUnits: childIssues.map((child) => {
      const matchingLease = leases.find((l) => l.issueId === child.id && l.status === "active");
      return {
        id: child.id,
        paperclipChildIssueId: child.id,
        githubChildIssueId: null,
        owner: child.assigneeAgentId ?? "unassigned",
        acceptanceCriteria: child.description ? [child.description] : [],
        tests: [],
        mutationScope: {
          repositories: matchingLease?.scopeRepositories ?? [],
          paths: matchingLease?.scopePaths ?? [],
        },
        state: mapIssueStatusToWorkUnitState(child.status),
      };
    }),
    participants: participations.map((p) => ({
      id: p.id,
      runtime: p.runtime,
      role: (p.role as "lead" | "worker" | "reviewer" | "helper") || "worker",
      mode: (p.mode as "mutate" | "read" | "review") || "mutate",
      enforcementMode: (p.enforcementMode as "observe" | "enforce_mutations") || "observe",
      runId: p.runId,
      sessionId: p.sessionId,
      currentAction: p.currentAction,
      progressNote: p.progressNote,
      blocker: p.blocker,
      nextAction: p.nextAction,
      retryState: p.retryState,
      startedAt: p.startedAt.toISOString(),
      lastSeenAt: p.lastSeenAt.toISOString(),
      endedAt: p.endedAt ? p.endedAt.toISOString() : null,
    })),
    placements: hosts.map((h) => ({
      hostId: h.hostId,
      hostname: h.hostname,
      os: h.os,
      runtime: h.runtime,
      reachableAddresses: h.reachableAddresses ?? [],
      environment: h.environment ?? "local",
      nativePath: "",
      runtimePath: "",
      worktreeIdentity: "",
      repository: "",
      branch: "dev",
      dirty: false,
    })),
    delivery: {
      commits: [],
      pullRequests: [],
    },
    health: {
      heartbeatAgeSeconds,
      processEvidence: true,
      outputEvidence: true,
      status: healthStatus,
      freshnessTimestamp: mostRecentSeen.toISOString(),
      evidenceSource: "paperclip-db",
    },
    controls: {
      permittedIntents: ["pause", "cancel", "retry", "release", "reassign", "takeover"],
      pendingIntents: intents.filter((i) => i.status === "pending").map((i) => ({
        id: i.id,
        intentType: i.intentType,
        targetWorkUnitId: i.targetWorkUnitId,
        requestedBy: i.requestedBy,
        createdAt: i.createdAt.toISOString(),
      })),
      completedReceipts: intents.filter((i) => i.status === "executed").map((i) => ({
        id: i.id,
        intentType: i.intentType,
        receipt: i.receipt,
        executedAt: i.executedAt?.toISOString() ?? null,
      })),
    },
    provenance: {
      sourceAuthority: "paperclip",
      observedAt: now.toISOString(),
      confidence: 1.0,
      reconciliationDrift: false,
      driftDetails: [],
    },
  };
}

export async function getCompanyCoordinationTasks(
  db: Db,
  companyId: string,
): Promise<TaskCoordinationView[]> {
  // Select top-level root issues (parentId is null)
  const rootIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), isNull(issues.parentId)));

  const results: TaskCoordinationView[] = [];
  for (const root of rootIssues) {
    const view = await getIssueCoordination(db, root.id, companyId);
    if (view) {
      results.push(view);
    }
  }

  return results;
}
