type TaskStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "under_review"
  | "completed"
  | "cancelled";

type WorkUnitState = "pending" | "in_progress" | "submitted" | "approved" | "failed";

export interface TaskCoordinationView {
  schemaVersion: "task-coordination.v1";
  task: {
    canonicalKey: string;
    githubProjectItemId: string | null;
    mckTaskId: string | null;
    paperclipParentIssueId: string | null;
    correlationId: string;
    status: TaskStatus;
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
    state: WorkUnitState;
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

export interface CoordinationProjectionSnapshot {
  observedAt: Date;
  rootIssue: {
    id: string;
    identifier: string | null;
    issueNumber: number | null;
    status: string;
    assigneeAgentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  childIssues: Array<{
    id: string;
    description: string | null;
    status: string;
    assigneeAgentId: string | null;
  }>;
  participations: Array<{
    id: string;
    agentInstanceId: string | null;
    runtime: string;
    role: string;
    mode: string;
    enforcementMode: string;
    runId: string | null;
    sessionId: string | null;
    currentAction: string | null;
    progressNote: string | null;
    blocker: string | null;
    nextAction: string | null;
    retryState: Record<string, unknown> | null;
    startedAt: Date;
    lastSeenAt: Date;
    endedAt: Date | null;
  }>;
  leases: Array<{
    issueId: string;
    status: string;
    scopeRepositories: string[];
    scopePaths: string[];
  }>;
  intents: Array<{
    id: string;
    status: string;
    intentType: string;
    targetWorkUnitId: string | null;
    requestedBy: string;
    createdAt: Date;
    receipt: Record<string, unknown> | null;
    executedAt: Date | null;
  }>;
  hosts: Array<{
    hostId: string;
    hostname: string;
    os: string;
    runtime: string;
    reachableAddresses: string[] | null;
    environment: string | null;
  }>;
}

function mapIssueStatusToTaskStatus(status: string): TaskStatus {
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

function mapIssueStatusToWorkUnitState(status: string): WorkUnitState {
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

function projectTask(snapshot: CoordinationProjectionSnapshot): TaskCoordinationView["task"] {
  const { rootIssue } = snapshot;
  const canonicalKey = rootIssue.identifier
    ? `github:${rootIssue.identifier}`
    : `github:paperclip/issue#${rootIssue.issueNumber}`;

  return {
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
  };
}

function projectWorkUnit(
  child: CoordinationProjectionSnapshot["childIssues"][number],
  leases: CoordinationProjectionSnapshot["leases"],
): TaskCoordinationView["workUnits"][number] {
  const matchingLease = leases.find((lease) => lease.issueId === child.id && lease.status === "active");
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
}

function projectParticipant(
  participation: CoordinationProjectionSnapshot["participations"][number],
): TaskCoordinationView["participants"][number] {
  return {
    id: participation.id,
    runtime: participation.runtime,
    role: (participation.role as "lead" | "worker" | "reviewer" | "helper") || "worker",
    mode: (participation.mode as "mutate" | "read" | "review") || "mutate",
    enforcementMode:
      (participation.enforcementMode as "observe" | "enforce_mutations") || "observe",
    runId: participation.runId,
    sessionId: participation.sessionId,
    currentAction: participation.currentAction,
    progressNote: participation.progressNote,
    blocker: participation.blocker,
    nextAction: participation.nextAction,
    retryState: participation.retryState,
    startedAt: participation.startedAt.toISOString(),
    lastSeenAt: participation.lastSeenAt.toISOString(),
    endedAt: participation.endedAt ? participation.endedAt.toISOString() : null,
  };
}

function projectPlacement(
  host: CoordinationProjectionSnapshot["hosts"][number],
): TaskCoordinationView["placements"][number] {
  return {
    hostId: host.hostId,
    hostname: host.hostname,
    os: host.os,
    runtime: host.runtime,
    reachableAddresses: host.reachableAddresses ?? [],
    environment: host.environment ?? "local",
    nativePath: "",
    runtimePath: "",
    worktreeIdentity: "",
    repository: "",
    branch: "dev",
    dirty: false,
  };
}

function projectHealth(snapshot: CoordinationProjectionSnapshot): TaskCoordinationView["health"] {
  const mostRecentSeen = snapshot.participations.reduce<Date>((latest, participation) => {
    const seenAt = new Date(participation.lastSeenAt.getTime());
    return seenAt > latest ? seenAt : latest;
  }, new Date(snapshot.rootIssue.updatedAt.getTime()));
  const heartbeatAgeSeconds = Math.max(
    0,
    Math.floor((snapshot.observedAt.getTime() - mostRecentSeen.getTime()) / 1000),
  );
  let status: TaskCoordinationView["health"]["status"] = "healthy";
  if (heartbeatAgeSeconds > 1800) {
    status = "orphaned";
  } else if (heartbeatAgeSeconds > 300) {
    status = "stale";
  }

  return {
    heartbeatAgeSeconds,
    processEvidence: true,
    outputEvidence: true,
    status,
    freshnessTimestamp: mostRecentSeen.toISOString(),
    evidenceSource: "paperclip-db",
  };
}

function projectControls(snapshot: CoordinationProjectionSnapshot): TaskCoordinationView["controls"] {
  return {
    permittedIntents: ["pause", "cancel", "retry", "release", "reassign", "takeover"],
    pendingIntents: snapshot.intents.filter((intent) => intent.status === "pending").map((intent) => ({
      id: intent.id,
      intentType: intent.intentType,
      targetWorkUnitId: intent.targetWorkUnitId,
      requestedBy: intent.requestedBy,
      createdAt: intent.createdAt.toISOString(),
    })),
    completedReceipts: snapshot.intents.filter((intent) => intent.status === "executed").map((intent) => ({
      id: intent.id,
      intentType: intent.intentType,
      receipt: intent.receipt,
      executedAt: intent.executedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Pure mapping only. The service loader must supply an already company-scoped
 * snapshot; this function performs no authorization or database filtering.
 */
export function projectTaskCoordinationView(
  snapshot: CoordinationProjectionSnapshot,
): TaskCoordinationView {
  return {
    schemaVersion: "task-coordination.v1",
    task: projectTask(snapshot),
    workUnits: snapshot.childIssues.map((child) => projectWorkUnit(child, snapshot.leases)),
    participants: snapshot.participations.map(projectParticipant),
    placements: snapshot.hosts.map(projectPlacement),
    delivery: { commits: [], pullRequests: [] },
    health: projectHealth(snapshot),
    controls: projectControls(snapshot),
    provenance: {
      sourceAuthority: "paperclip",
      observedAt: snapshot.observedAt.toISOString(),
      confidence: 1.0,
      reconciliationDrift: false,
      driftDetails: [],
    },
  };
}
