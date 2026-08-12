import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  taskParticipations,
  mutationLeases,
  controlIntents,
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
    heartbeatAgeSeconds: number | null;
    processEvidence: boolean;
    outputEvidence: boolean;
    status: "healthy" | "reporting_degraded" | "stale" | "orphaned" | "error" | "offline";
    freshnessTimestamp: string | null;
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

const FRESH_HEARTBEAT_SECONDS = 5 * 60;
const ORPHANED_HEARTBEAT_SECONDS = 30 * 60;

type CoordinationHealth = TaskCoordinationView["health"];

interface CoordinationEvidence {
  health: CoordinationHealth;
  confidence: number;
  reconciliationDrift: boolean;
  driftDetails: string[];
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function missingIndependentEvidence(): string[] {
  return [
    "No independently persisted process-custody evidence is available.",
    "No independently persisted output-delivery evidence is available.",
  ];
}

function unavailableCoordinationEvidence(
  status: CoordinationHealth["status"],
  evidenceSource: string,
  freshnessTimestamp: string | null,
  detail: string,
): CoordinationEvidence {
  return {
    health: {
      heartbeatAgeSeconds: null,
      processEvidence: false,
      outputEvidence: false,
      status,
      freshnessTimestamp,
      evidenceSource,
    },
    confidence: 0,
    reconciliationDrift: true,
    driftDetails: [detail, ...missingIndependentEvidence()],
  };
}

/**
 * Task participations prove that a participant reported, not that its process
 * is alive or that it produced an output. Keep those stronger claims false
 * until #28/#29/#30 add their independently persisted evidence sources.
 */
function deriveCoordinationEvidence(
  participations: Array<{ lastSeenAt: Date; endedAt: Date | null }>,
  now: Date,
): CoordinationEvidence {
  const activeParticipations = participations.filter((participation) => participation.endedAt === null);

  if (activeParticipations.length === 0) {
    return unavailableCoordinationEvidence(
      "offline",
      "paperclip-db:no-active-participation-record",
      null,
      "No active persisted coordination participation is available.",
    );
  }

  if (activeParticipations.some((participation) => !isValidDate(participation.lastSeenAt))) {
    return unavailableCoordinationEvidence(
      "error",
      "paperclip-db:invalid-participation-heartbeat",
      null,
      "An active participation has an invalid persisted heartbeat timestamp.",
    );
  }

  const mostRecentSeen = activeParticipations.reduce<Date>((latest, participation) => (
    participation.lastSeenAt > latest ? participation.lastSeenAt : latest
  ), activeParticipations[0].lastSeenAt);

  if (mostRecentSeen > now) {
    return unavailableCoordinationEvidence(
      "error",
      "paperclip-db:future-participation-heartbeat",
      mostRecentSeen.toISOString(),
      "The most recent active participation heartbeat is in the future.",
    );
  }

  const heartbeatAgeSeconds = Math.floor((now.getTime() - mostRecentSeen.getTime()) / 1000);
  const status = heartbeatAgeSeconds > ORPHANED_HEARTBEAT_SECONDS
    ? "orphaned"
    : heartbeatAgeSeconds > FRESH_HEARTBEAT_SECONDS
      ? "stale"
      : "reporting_degraded";

  return {
    health: {
      heartbeatAgeSeconds,
      processEvidence: false,
      outputEvidence: false,
      status,
      freshnessTimestamp: mostRecentSeen.toISOString(),
      evidenceSource: "paperclip-db:participation-heartbeat-only",
    },
    // A recent report is useful freshness evidence, but there is no persisted
    // confidence verdict in this read model. Do not invent a numeric score.
    confidence: 0,
    reconciliationDrift: true,
    driftDetails: [
      status === "reporting_degraded"
        ? "A fresh participation heartbeat proves reporting only."
        : "The active participation heartbeat is not fresh enough for reporting confidence.",
      ...missingIndependentEvidence(),
    ],
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

export async function getIssueCoordination(
  db: Db,
  rootIssueId: string,
): Promise<TaskCoordinationView | null> {
  const rootIssue = await db
    .select()
    .from(issues)
    .where(eq(issues.id, rootIssueId))
    .then((rows) => rows[0] ?? null);

  if (!rootIssue) {
    return null;
  }

  // Fetch child issues / work units
  const childIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.parentId, rootIssueId));

  const allIssueIds = [rootIssue.id, ...childIssues.map((c) => c.id)];

  // Fetch participations, leases, intents
  const participations = await db
    .select()
    .from(taskParticipations)
    .where(inArray(taskParticipations.issueId, allIssueIds));

  const leases = await db
    .select()
    .from(mutationLeases)
    .where(inArray(mutationLeases.issueId, allIssueIds));

  const intents = await db
    .select()
    .from(controlIntents)
    .where(eq(controlIntents.rootIssueId, rootIssue.id));

  const now = new Date();
  const evidence = deriveCoordinationEvidence(participations, now);

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
    // Host records do not persist repository, branch, dirty state, or process
    // custody. Returning no placement is more truthful than fabricating those
    // operational facts from a host registration.
    placements: [],
    delivery: {
      commits: [],
      pullRequests: [],
    },
    health: evidence.health,
    controls: {
      // #52 owns authorization. The coordination read model must not claim
      // that an intent is permitted until that decision has a persisted source.
      permittedIntents: [],
      pendingIntents: intents.filter((i) => i.status === "pending").map((i) => ({
        id: i.id,
        intentType: i.intentType,
        targetWorkUnitId: i.targetWorkUnitId,
        requestedBy: i.requestedBy,
        createdAt: i.createdAt.toISOString(),
      })),
      completedReceipts: intents
        .filter((i) => i.status === "executed" && i.receipt && Object.keys(i.receipt).length > 0)
        .map((i) => ({
        id: i.id,
        intentType: i.intentType,
        receipt: i.receipt,
        executedAt: i.executedAt?.toISOString() ?? null,
        })),
    },
    provenance: {
      sourceAuthority: "paperclip",
      observedAt: now.toISOString(),
      confidence: evidence.confidence,
      reconciliationDrift: evidence.reconciliationDrift,
      driftDetails: evidence.driftDetails,
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
    const view = await getIssueCoordination(db, root.id);
    if (view) {
      results.push(view);
    }
  }

  return results;
}
