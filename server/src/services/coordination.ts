import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

export const ISSUE_COORDINATION_WORK_UNIT_LIMIT = 100;
export const ISSUE_COORDINATION_PARTICIPATION_LIMIT = 200;
export const ISSUE_COORDINATION_LEASE_LIMIT = 200;
export const ISSUE_COORDINATION_INTENT_LIMIT = 200;

type IssueRow = typeof issues.$inferSelect;
type TaskParticipationRow = typeof taskParticipations.$inferSelect;
type MutationLeaseRow = typeof mutationLeases.$inferSelect;
type ControlIntentRow = typeof controlIntents.$inferSelect;
type AgentInstanceRow = typeof agentInstances.$inferSelect;
type HostNodeRow = typeof hostNodes.$inferSelect;

interface PrefetchedIssueCoordinationRows {
  rootIssue: IssueRow;
  childIssues: IssueRow[];
  participations: TaskParticipationRow[];
  leases: MutationLeaseRow[];
  intents: ControlIntentRow[];
  instances: AgentInstanceRow[];
  hosts: HostNodeRow[];
  leaseAuthorityComplete: boolean;
  driftDetails: string[];
}

function boundProjectionRows<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  collection: string,
  globalBatchTruncated = false,
): { rows: T[]; driftDetails: string[] } {
  const selected = rows.slice(0, limit);
  if (rows.length <= limit && !globalBatchTruncated) {
    return { rows: selected, driftDetails: [] };
  }
  const afterId = selected.at(-1)?.id ?? null;
  return {
    rows: selected,
    driftDetails: [
      `Coordination projection '${collection}' was truncated at ${limit} row(s); `
      + `last projected id=${afterId ?? "none"}. Reconcile the authoritative source before treating omitted history as absent.`,
    ],
  };
}

function sanitizeRepositoryRemoteUrl(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.hostname) return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Git's SCP-like syntax is not URL-parseable. Preserve only the host/path
    // repository identity and discard the user field, query, and fragment.
    const scpLike = raw.match(/^[^@\s]+@([^:\s]+):([^?#\s]+)(?:[?#].*)?$/);
    return scpLike ? `${scpLike[1]}:${scpLike[2]}` : undefined;
  }
}

export interface IssueCoordinationResource {
  companyId: string;
  view: TaskCoordinationView;
  placementViewerAgentIds: string[];
}

type CoordinationRuntime =
  | "paperclip-native"
  | "claude-code"
  | "codex-desktop"
  | "hermes"
  | "openclaw"
  | "manual";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function normalizeParticipantRuntime(runtime: string, driftDetails: string[]): CoordinationRuntime {
  switch (runtime) {
    case "paperclip-native":
    case "claude-code":
    case "codex-desktop":
    case "hermes":
    case "openclaw":
    case "manual":
      return runtime;
    case "claude":
    case "claude_local":
    case "claude-local":
      return "claude-code";
    case "codex":
    case "codex_local":
    case "codex-local":
      return "codex-desktop";
    case "hermes_local":
    case "hermes_gateway":
      return "hermes";
    case "openclaw_gateway":
      return "openclaw";
    case "process":
    case "http":
    case "cursor":
    case "cursor_local":
    case "gemini_local":
    case "opencode_local":
    case "pi_local":
      return "paperclip-native";
    default:
      driftDetails.push(`Participant runtime '${runtime}' is not in task-coordination.v1; reported as manual.`);
      return "manual";
  }
}

function normalizeRole(value: string, driftDetails: string[]): "lead" | "worker" | "reviewer" | "helper" {
  if (value === "lead" || value === "worker" || value === "reviewer" || value === "helper") return value;
  driftDetails.push(`Participant role '${value}' is not in task-coordination.v1; reported as worker.`);
  return "worker";
}

function normalizeMode(value: string, driftDetails: string[]): "mutate" | "read" | "review" {
  if (value === "mutate" || value === "read" || value === "review") return value;
  driftDetails.push(`Participant mode '${value}' is not in task-coordination.v1; reported as read.`);
  return "read";
}

function normalizeEnforcementMode(
  value: string,
  driftDetails: string[],
): "observe" | "enforce_mutations" {
  if (value === "observe" || value === "enforce_mutations") return value;
  driftDetails.push(`Participant enforcement mode '${value}' is unknown; reported as observe.`);
  return "observe";
}

function syntheticIssueNumber(companyId: string, issueId: string): string {
  const stableHex = `${companyId}${issueId}`.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(stableHex)) {
    throw new Error("Paperclip coordination identity is not a hexadecimal UUID pair");
  }
  return BigInt(`0x${stableHex}`).toString(10);
}

export function resolveCoordinationCanonicalKey(
  issue: {
    companyId: string;
    id: string;
    identifier: string | null;
    originKind: string;
    originId: string | null;
  },
  driftDetails: string[],
): string {
  const candidates = [issue.originId, issue.identifier]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (issue.originKind === "github" && /^github:[^/]+\/[^#]+#\d+$/.test(candidate)) {
      return candidate;
    }
    if (issue.originKind === "github" && /^[^/]+\/[^#]+#\d+$/.test(candidate)) {
      return `github:${candidate}`;
    }
    const urlMatch = candidate.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/)?$/i);
    if (issue.originKind === "github" && urlMatch) {
      return `github:${urlMatch[1]}/${urlMatch[2]}#${urlMatch[3]}`;
    }
  }

  const localNumber = syntheticIssueNumber(issue.companyId, issue.id);
  driftDetails.push(
    "No persisted GitHub canonical key exists for this Paperclip issue; canonicalKey uses a synthetic company-and-issue-derived github:unlinked/paperclip identity and must not be treated as a provider mapping.",
  );
  return `github:unlinked/paperclip#${localNumber}`;
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

export async function getIssueCoordinationScope(
  db: Db,
  rootIssueId: string,
): Promise<{ id: string; companyId: string } | null> {
  return db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, rootIssueId))
    .then((rows) => rows[0] ?? null);
}

export async function getIssueCoordination(
  db: Db,
  rootIssueId: string,
  expectedCompanyId?: string,
  prefetched?: PrefetchedIssueCoordinationRows,
): Promise<IssueCoordinationResource | null> {
  const rootIssue = prefetched?.rootIssue ?? await db
    .select()
    .from(issues)
    .where(expectedCompanyId
      ? and(eq(issues.id, rootIssueId), eq(issues.companyId, expectedCompanyId))
      : eq(issues.id, rootIssueId))
    .then((rows) => rows[0] ?? null);

  if (!rootIssue || rootIssue.id !== rootIssueId || (expectedCompanyId && rootIssue.companyId !== expectedCompanyId)) {
    return null;
  }

  const projectionDriftDetails = [...(prefetched?.driftDetails ?? [])];
  // Fetch child issues / work units with one sentinel row so high-fanout roots
  // cannot create an unbounded DTO.
  const childProjection = prefetched
    ? { rows: prefetched.childIssues, driftDetails: [] }
    : boundProjectionRows(
      await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, rootIssue.companyId), eq(issues.parentId, rootIssueId)))
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(ISSUE_COORDINATION_WORK_UNIT_LIMIT + 1),
      ISSUE_COORDINATION_WORK_UNIT_LIMIT,
      "workUnits",
    );
  const childIssues = childProjection.rows;
  projectionDriftDetails.push(...childProjection.driftDetails);

  const allIssueIds = [rootIssue.id, ...childIssues.map((c) => c.id)];

  // Fetch participations, leases, intents
  const participationProjection = prefetched
    ? { rows: prefetched.participations, driftDetails: [] }
    : boundProjectionRows(
      await db
        .select()
        .from(taskParticipations)
        .where(and(
          eq(taskParticipations.companyId, rootIssue.companyId),
          inArray(taskParticipations.issueId, allIssueIds),
        ))
        .orderBy(desc(taskParticipations.lastSeenAt), desc(taskParticipations.id))
        .limit(ISSUE_COORDINATION_PARTICIPATION_LIMIT + 1),
      ISSUE_COORDINATION_PARTICIPATION_LIMIT,
      "participants",
    );
  const participations = participationProjection.rows;
  projectionDriftDetails.push(...participationProjection.driftDetails);
  const activeParticipations = participations.filter((participation) => !participation.endedAt);

  const leaseProjection = prefetched
    ? { rows: prefetched.leases, driftDetails: [] }
    : boundProjectionRows(
      await db
        .select()
        .from(mutationLeases)
        .where(and(
          eq(mutationLeases.companyId, rootIssue.companyId),
          inArray(mutationLeases.issueId, allIssueIds),
        ))
        .orderBy(desc(mutationLeases.generation), desc(mutationLeases.updatedAt), desc(mutationLeases.id))
        .limit(ISSUE_COORDINATION_LEASE_LIMIT + 1),
      ISSUE_COORDINATION_LEASE_LIMIT,
      "mutationLeases",
    );
  const leases = leaseProjection.rows;
  projectionDriftDetails.push(...leaseProjection.driftDetails);
  const leaseAuthorityComplete = prefetched?.leaseAuthorityComplete ?? (
    leaseProjection.driftDetails.length === 0
    && childProjection.driftDetails.length === 0
  );

  const intentProjection = prefetched
    ? { rows: prefetched.intents, driftDetails: [] }
    : boundProjectionRows(
      await db
        .select()
        .from(controlIntents)
        .where(and(
          eq(controlIntents.companyId, rootIssue.companyId),
          eq(controlIntents.rootIssueId, rootIssue.id),
        ))
        .orderBy(desc(controlIntents.createdAt), desc(controlIntents.id))
        .limit(ISSUE_COORDINATION_INTENT_LIMIT + 1),
      ISSUE_COORDINATION_INTENT_LIMIT,
      "controlIntents",
    );
  const intents = intentProjection.rows;
  projectionDriftDetails.push(...intentProjection.driftDetails);

  // Fetch agent instances and host nodes
  const agentInstanceIds = [
    ...new Set(
      activeParticipations
        .map((p) => p.agentInstanceId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  const queriedInstances = prefetched?.instances ?? (agentInstanceIds.length > 0
    ? await db.select().from(agentInstances).where(and(
      eq(agentInstances.companyId, rootIssue.companyId),
      eq(agentInstances.status, "active"),
      inArray(agentInstances.id, agentInstanceIds),
    ))
    : []);
  const instances = queriedInstances.filter((instance) => (
    instance.status === "active" && agentInstanceIds.includes(instance.id)
  ));

  const hostNodeIds = [
    ...new Set(
      instances
        .map((i) => i.hostNodeId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  const hosts = prefetched?.hosts ?? (hostNodeIds.length > 0
    ? await db.select().from(hostNodes).where(and(
      eq(hostNodes.companyId, rootIssue.companyId),
      inArray(hostNodes.id, hostNodeIds),
    ))
    : []);

  const now = new Date();
  const driftDetails: string[] = [];
  driftDetails.push(...projectionDriftDetails);
  driftDetails.push(
    "Task status and accountable lead are Paperclip issue projections; GitHub Issues/Projects authority was not reconciled for this view.",
  );
  const isCurrentLease = (lease: (typeof leases)[number]): boolean => {
    const expiresAt = lease.expiresAt instanceof Date ? lease.expiresAt.getTime() : Number.NaN;
    return lease.status === "active"
      && lease.releasedAt == null
      && Number.isFinite(expiresAt)
      && expiresAt > now.getTime();
  };
  const currentLeases = leaseAuthorityComplete ? leases.filter(isCurrentLease) : [];
  if (!leaseAuthorityComplete) {
    driftDetails.push(
      "Mutation-lease projection is incomplete; all mutation scope is withheld until authoritative lease reconciliation completes.",
    );
  }
  const excludedActiveLeaseCount = leases.filter((lease) => (
    lease.status === "active" && !isCurrentLease(lease)
  )).length;
  if (excludedActiveLeaseCount > 0) {
    driftDetails.push(
      `${excludedActiveLeaseCount} status-active mutation lease(s) were expired, released, or invalid and were excluded from current mutation authority.`,
    );
  }
  for (const issueId of allIssueIds) {
    const issueLeaseCount = currentLeases.filter((lease) => lease.issueId === issueId).length;
    if (issueLeaseCount > 1) {
      driftDetails.push(
        `Issue '${issueId}' has ${issueLeaseCount} concurrent unexpired active mutation leases; mutation scope is withheld because lease authority is ambiguous.`,
      );
    }
  }
  const taskStatus = mapIssueStatusToTaskStatus(rootIssue.status);
  const freshnessParticipations = activeParticipations.length > 0
    ? activeParticipations
    : participations;
  const mostRecentSeen = freshnessParticipations.reduce<Date | null>((latest, p) => {
    const t = new Date(p.lastSeenAt);
    return latest === null || t > latest ? t : latest;
  }, null) ?? new Date(rootIssue.updatedAt);

  const heartbeatAgeSeconds = Math.max(0, Math.floor((now.getTime() - mostRecentSeen.getTime()) / 1000));

  let healthStatus: "healthy" | "reporting_degraded" | "stale" | "orphaned" | "error" | "offline";
  let healthEvidenceSource: string;
  if (participations.length === 0) {
    healthStatus = taskStatus === "completed" || taskStatus === "cancelled" ? "offline" : "reporting_degraded";
    healthEvidenceSource = "paperclip-issue-updated-at";
    if (healthStatus === "reporting_degraded") {
      driftDetails.push("No task participation heartbeat exists; issue updatedAt is not process or output evidence.");
    }
  } else if (activeParticipations.length === 0) {
    healthStatus = "offline";
    healthEvidenceSource = "paperclip-task-participations";
  } else if (heartbeatAgeSeconds > 900) {
    healthStatus = "stale";
    healthEvidenceSource = "paperclip-task-participations";
    if (heartbeatAgeSeconds > 1800) {
      driftDetails.push(
        "Heartbeat is older than the orphan threshold, but no independent process-death evidence is persisted; health remains stale rather than claiming orphaned.",
      );
    }
  } else {
    healthStatus = "healthy";
    healthEvidenceSource = "paperclip-task-participations";
  }

  const canonicalKey = resolveCoordinationCanonicalKey(rootIssue, driftDetails);
  // Generation is monotonic history, not current mutation authority. Expired or
  // released leases can establish a prior generation but cannot expose scope.
  const generation = Math.max(1, ...leases.map((lease) => lease.generation));

  const participants = participations.map((participation) => ({
    id: participation.id,
    runtime: normalizeParticipantRuntime(participation.runtime, driftDetails),
    role: normalizeRole(participation.role, driftDetails),
    mode: normalizeMode(participation.mode, driftDetails),
    enforcementMode: normalizeEnforcementMode(participation.enforcementMode, driftDetails),
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
  }));

  const workUnits: TaskCoordinationView["workUnits"] = childIssues.map((child) => {
    const matchingLeases = currentLeases.filter((lease) => lease.issueId === child.id);
    const matchingLease = matchingLeases.length === 1 ? matchingLeases[0] : undefined;
    return {
      id: child.id,
      paperclipChildIssueId: child.id,
      githubChildIssueId: null,
      owner: child.assigneeAgentId ?? "unassigned",
      acceptanceCriteria: [],
      tests: [],
      mutationScope: {
        repositories: matchingLease?.scopeRepositories ?? [],
        paths: matchingLease?.scopePaths ?? [],
      },
      state: mapIssueStatusToWorkUnitState(child.status),
    };
  });

  const placements: TaskCoordinationView["placements"] = [];
  for (const instance of instances) {
    const host = hosts.find((candidate) => candidate.id === instance.hostNodeId);
    if (!host) {
      driftDetails.push(`Agent instance '${instance.id}' has no company-scoped host placement evidence.`);
      continue;
    }

    const instanceMetadata = isRecord(instance.metadata) ? instance.metadata : {};
    const metadata = isRecord(instanceMetadata.placement) ? instanceMetadata.placement : instanceMetadata;
    const repository = optionalString(metadata.repository);
    const branch = optionalString(metadata.branch);
    const dirty = typeof metadata.dirty === "boolean" ? metadata.dirty : undefined;
    if (!repository || !branch || dirty === undefined) {
      driftDetails.push(
        `Host '${host.hostId}' lacks repository, branch, or dirty-state evidence; no optimistic placement was emitted.`,
      );
      continue;
    }

    const processId = typeof metadata.processId === "number" && Number.isInteger(metadata.processId)
      ? metadata.processId
      : undefined;
    const remoteUrl = sanitizeRepositoryRemoteUrl(metadata.remoteUrl);
    placements.push({
      hostId: host.hostId,
      hostname: host.hostname,
      os: host.os,
      runtime: host.runtime,
      ...(host.reachableAddresses ? { reachableAddresses: host.reachableAddresses } : {}),
      ...(host.environment ? { environment: host.environment } : {}),
      ...(optionalString(metadata.nativePath) ? { nativePath: optionalString(metadata.nativePath) } : {}),
      ...(optionalString(metadata.runtimePath) ? { runtimePath: optionalString(metadata.runtimePath) } : {}),
      ...(optionalString(metadata.worktreeIdentity)
        ? { worktreeIdentity: optionalString(metadata.worktreeIdentity) }
        : {}),
      repository,
      ...(remoteUrl ? { remoteUrl } : {}),
      branch,
      ...(optionalString(metadata.baseSha) ? { baseSha: optionalString(metadata.baseSha) } : {}),
      ...(optionalString(metadata.headSha) ? { headSha: optionalString(metadata.headSha) } : {}),
      dirty,
      ...(typeof metadata.aheadCount === "number" && Number.isInteger(metadata.aheadCount)
        ? { aheadCount: metadata.aheadCount }
        : {}),
      ...(typeof metadata.behindCount === "number" && Number.isInteger(metadata.behindCount)
        ? { behindCount: metadata.behindCount }
        : {}),
      ...(processId !== undefined ? { processId } : {}),
      ...(optionalString(metadata.processGroup) ? { processGroup: optionalString(metadata.processGroup) } : {}),
      ...(optionalStringArray(metadata.serviceReferences)
        ? { serviceReferences: optionalStringArray(metadata.serviceReferences) }
        : {}),
      ...(optionalStringArray(metadata.logReferences)
        ? { logReferences: optionalStringArray(metadata.logReferences) }
        : {}),
    });
  }

  driftDetails.push(
    "Commit and pull-request delivery facts are not persisted in the Paperclip coordination tables; empty delivery arrays mean unavailable, not independently verified absent.",
  );
  const uniqueDriftDetails = [...new Set(driftDetails)];

  return {
    companyId: rootIssue.companyId,
    placementViewerAgentIds: [
      rootIssue.assigneeAgentId,
      ...childIssues.map((child) => child.assigneeAgentId),
      ...instances.map((instance) => instance.agentId),
    ].filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0),
    view: {
      schemaVersion: "task-coordination.v1",
      task: {
        canonicalKey,
        githubProjectItemId: null,
        mckTaskId: null,
        paperclipParentIssueId: rootIssue.id,
        correlationId: rootIssue.id,
        status: taskStatus,
        accountableLead: rootIssue.assigneeAgentId ?? "unassigned",
        generation,
        createdAt: rootIssue.createdAt.toISOString(),
        updatedAt: rootIssue.updatedAt.toISOString(),
      },
      workUnits,
      participants,
      placements,
      delivery: {
        commits: [],
        pullRequests: [],
      },
      health: {
        heartbeatAgeSeconds,
        status: healthStatus,
        freshnessTimestamp: mostRecentSeen.toISOString(),
        evidenceSource: healthEvidenceSource,
      },
      controls: {
        permittedIntents: [],
        pendingIntents: intents.filter((intent) => intent.status === "pending").map((intent) => ({
          id: intent.id,
          intentType: intent.intentType,
          targetWorkUnitId: intent.targetWorkUnitId,
          requestedBy: intent.requestedBy,
          createdAt: intent.createdAt.toISOString(),
        })),
        completedReceipts: intents.filter((intent) => intent.status === "executed").map((intent) => ({
          id: intent.id,
          intentType: intent.intentType,
          receipt: intent.receipt,
          executedAt: intent.executedAt?.toISOString() ?? null,
        })),
      },
      provenance: {
        sourceAuthority: "paperclip",
        observedAt: now.toISOString(),
        confidence: uniqueDriftDetails.length > 0 ? 0.5 : 1,
        reconciliationDrift: uniqueDriftDetails.length > 0,
        ...(uniqueDriftDetails.length > 0 ? { driftDetails: uniqueDriftDetails } : {}),
      },
    },
  };
}

export const COMPANY_COORDINATION_TASKS_DEFAULT_LIMIT = 50;
export const COMPANY_COORDINATION_TASKS_MAX_LIMIT = 100;
export const COMPANY_COORDINATION_TASKS_MAX_OFFSET = 10_000;

export interface CompanyCoordinationTaskListOptions {
  limit?: number;
  offset?: number;
}

export async function getCompanyCoordinationTasks(
  db: Db,
  companyId: string,
  options: CompanyCoordinationTaskListOptions = {},
): Promise<TaskCoordinationView[]> {
  // Keep direct service callers bounded even when they bypass the HTTP query
  // parser. The route rejects invalid values; this fallback prevents an
  // internal caller from accidentally restoring an unbounded collection.
  const limit = typeof options.limit === "number"
    && Number.isSafeInteger(options.limit)
    && options.limit > 0
    ? Math.min(options.limit, COMPANY_COORDINATION_TASKS_MAX_LIMIT)
    : COMPANY_COORDINATION_TASKS_DEFAULT_LIMIT;
  const offset = typeof options.offset === "number"
    && Number.isSafeInteger(options.offset)
    && options.offset >= 0
    ? Math.min(options.offset, COMPANY_COORDINATION_TASKS_MAX_OFFSET)
    : 0;

  // Select top-level root issues (parentId is null)
  const rootIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), isNull(issues.parentId)))
    .orderBy(desc(issues.updatedAt), desc(issues.id))
    .limit(limit)
    .offset(offset);

  if (rootIssues.length === 0) return [];

  // Materialize a collection page in a fixed query set. The previous
  // root-by-root detail loop issued up to seven sequential queries per root
  // (roughly 700 round trips at the public maximum page size) and allowed a
  // single high-fanout root to return an unbounded DTO.
  const rootIssueIds = rootIssues.map((root) => root.id);
  const childBatchLimit = rootIssues.length * ISSUE_COORDINATION_WORK_UNIT_LIMIT;
  const rawChildIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, rootIssueIds)))
    .orderBy(desc(issues.updatedAt), desc(issues.id))
    .limit(childBatchLimit + 1);
  const childBatchTruncated = rawChildIssues.length > childBatchLimit;
  const childProjectionByRoot = new Map<string, ReturnType<typeof boundProjectionRows<IssueRow>>>();
  for (const root of rootIssues) {
    childProjectionByRoot.set(root.id, boundProjectionRows(
      rawChildIssues.filter((child) => child.parentId === root.id),
      ISSUE_COORDINATION_WORK_UNIT_LIMIT,
      "workUnits",
      childBatchTruncated,
    ));
  }

  const issueToRoot = new Map<string, string>();
  for (const root of rootIssues) {
    issueToRoot.set(root.id, root.id);
    for (const child of childProjectionByRoot.get(root.id)?.rows ?? []) {
      issueToRoot.set(child.id, root.id);
    }
  }
  const projectedIssueIds = [...issueToRoot.keys()];

  const participationBatchLimit = rootIssues.length * ISSUE_COORDINATION_PARTICIPATION_LIMIT;
  const rawParticipations = await db
    .select()
    .from(taskParticipations)
    .where(and(
      eq(taskParticipations.companyId, companyId),
      inArray(taskParticipations.issueId, projectedIssueIds),
    ))
    .orderBy(desc(taskParticipations.lastSeenAt), desc(taskParticipations.id))
    .limit(participationBatchLimit + 1);
  const participationBatchTruncated = rawParticipations.length > participationBatchLimit;

  const leaseBatchLimit = rootIssues.length * ISSUE_COORDINATION_LEASE_LIMIT;
  const rawLeases = await db
    .select()
    .from(mutationLeases)
    .where(and(
      eq(mutationLeases.companyId, companyId),
      inArray(mutationLeases.issueId, projectedIssueIds),
    ))
    .orderBy(desc(mutationLeases.generation), desc(mutationLeases.updatedAt), desc(mutationLeases.id))
    .limit(leaseBatchLimit + 1);
  const leaseBatchTruncated = rawLeases.length > leaseBatchLimit;

  const intentBatchLimit = rootIssues.length * ISSUE_COORDINATION_INTENT_LIMIT;
  const rawIntents = await db
    .select()
    .from(controlIntents)
    .where(and(
      eq(controlIntents.companyId, companyId),
      inArray(controlIntents.rootIssueId, rootIssueIds),
    ))
    .orderBy(desc(controlIntents.createdAt), desc(controlIntents.id))
    .limit(intentBatchLimit + 1);
  const intentBatchTruncated = rawIntents.length > intentBatchLimit;

  const participationProjectionByRoot = new Map<string, ReturnType<typeof boundProjectionRows<TaskParticipationRow>>>();
  const leaseProjectionByRoot = new Map<string, ReturnType<typeof boundProjectionRows<MutationLeaseRow>>>();
  const intentProjectionByRoot = new Map<string, ReturnType<typeof boundProjectionRows<ControlIntentRow>>>();
  for (const root of rootIssues) {
    participationProjectionByRoot.set(root.id, boundProjectionRows(
      rawParticipations.filter((row) => issueToRoot.get(row.issueId) === root.id),
      ISSUE_COORDINATION_PARTICIPATION_LIMIT,
      "participants",
      participationBatchTruncated,
    ));
    leaseProjectionByRoot.set(root.id, boundProjectionRows(
      rawLeases.filter((row) => issueToRoot.get(row.issueId) === root.id),
      ISSUE_COORDINATION_LEASE_LIMIT,
      "mutationLeases",
      leaseBatchTruncated,
    ));
    intentProjectionByRoot.set(root.id, boundProjectionRows(
      rawIntents.filter((row) => row.rootIssueId === root.id),
      ISSUE_COORDINATION_INTENT_LIMIT,
      "controlIntents",
      intentBatchTruncated,
    ));
  }

  const selectedParticipations = [...participationProjectionByRoot.values()].flatMap((projection) => projection.rows);
  const activeAgentInstanceIds = [...new Set(selectedParticipations
    .filter((participation) => !participation.endedAt)
    .map((participation) => participation.agentInstanceId)
    .filter((id): id is string => typeof id === "string"))];
  const activeAgentInstanceIdSet = new Set(activeAgentInstanceIds);
  const queriedInstances = activeAgentInstanceIds.length > 0
    ? await db.select().from(agentInstances).where(and(
      eq(agentInstances.companyId, companyId),
      eq(agentInstances.status, "active"),
      inArray(agentInstances.id, activeAgentInstanceIds),
    ))
    : [];
  const selectedInstances = queriedInstances.filter((instance) => (
    instance.status === "active" && activeAgentInstanceIdSet.has(instance.id)
  ));
  const selectedHostNodeIds = [...new Set(selectedInstances
    .map((instance) => instance.hostNodeId)
    .filter((id): id is string => typeof id === "string"))];
  const selectedHosts = selectedHostNodeIds.length > 0
    ? await db.select().from(hostNodes).where(and(
      eq(hostNodes.companyId, companyId),
      inArray(hostNodes.id, selectedHostNodeIds),
    ))
    : [];

  const results: TaskCoordinationView[] = [];
  for (const root of rootIssues) {
    const childProjection = childProjectionByRoot.get(root.id)!;
    const participationProjection = participationProjectionByRoot.get(root.id)!;
    const leaseProjection = leaseProjectionByRoot.get(root.id)!;
    const intentProjection = intentProjectionByRoot.get(root.id)!;
    const rootAgentInstanceIds = new Set(participationProjection.rows
      .filter((participation) => !participation.endedAt)
      .map((participation) => participation.agentInstanceId)
      .filter((id): id is string => typeof id === "string"));
    const instances = selectedInstances.filter((instance) => rootAgentInstanceIds.has(instance.id));
    const rootHostNodeIds = new Set(instances
      .map((instance) => instance.hostNodeId)
      .filter((id): id is string => typeof id === "string"));
    const driftDetails = [
      ...childProjection.driftDetails,
      ...participationProjection.driftDetails,
      ...leaseProjection.driftDetails,
      ...intentProjection.driftDetails,
    ];
    const resource = await getIssueCoordination(db, root.id, companyId, {
      rootIssue: root,
      childIssues: childProjection.rows,
      participations: participationProjection.rows,
      leases: leaseProjection.rows,
      intents: intentProjection.rows,
      instances,
      hosts: selectedHosts.filter((host) => rootHostNodeIds.has(host.id)),
      leaseAuthorityComplete: (
        leaseProjection.driftDetails.length === 0
        && childProjection.driftDetails.length === 0
      ),
      driftDetails,
    });
    if (resource?.companyId === companyId) {
      results.push(resource.view);
    }
  }

  return results;
}
