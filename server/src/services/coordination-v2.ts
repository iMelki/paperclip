import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as AjvModule from "ajv";
import * as AjvFormatsModule from "ajv-formats";
import type { ErrorObject } from "ajv";
import type { Db } from "@paperclipai/db";
import {
  loadIssueCoordinationSnapshot,
} from "./coordination.js";
import {
  type CoordinationProjectionSnapshot,
} from "./coordination-projection.js";

export const TASK_COORDINATION_V2_SCHEMA_SHA256 =
  "3f47037b1f7b5e1705e719e4b087be88223abac19590521024d2f8960823b258";

const schemaBytes = readFileSync(new URL("../contracts/task-coordination.v2.json", import.meta.url));
const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
if (schemaSha256 !== TASK_COORDINATION_V2_SCHEMA_SHA256) {
  throw new Error(
    `task-coordination.v2 schema hash mismatch: expected ${TASK_COORDINATION_V2_SCHEMA_SHA256}, got ${schemaSha256}`,
  );
}

const schema = JSON.parse(schemaBytes.toString("utf8")) as object;
const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as {
  new (options: Record<string, unknown>): import("ajv").default;
};
const addFormats = ((AjvFormatsModule as unknown as { default?: (instance: unknown) => unknown }).default
  ?? AjvFormatsModule) as unknown as (instance: unknown) => unknown;
const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv);
const validateSchema = ajv.compile(schema);

type TaskStatus = "open" | "in_progress" | "blocked" | "under_review" | "completed" | "cancelled";
type WorkUnitState = "pending" | "in_progress" | "submitted" | "approved" | "failed";

interface CoordinationEvidence {
  health: TaskCoordinationViewV2["health"];
  confidence: number;
  reconciliationDrift: true;
  driftDetails: string[];
}

export interface TaskCoordinationViewV2 {
  schemaVersion: "task-coordination.v2";
  task: {
    canonicalKey: null;
    githubProjectItemId: string | null;
    mckTaskId: string | null;
    paperclipParentIssueId: string;
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
    mutationScope: { repositories: string[]; paths: string[] };
    state: WorkUnitState;
  }>;
  participants: Array<Record<string, unknown>>;
  placements: Array<Record<string, unknown>>;
  delivery: { commits: string[]; pullRequests: [] };
  health: {
    heartbeatAgeSeconds: number | null;
    processEvidence: boolean;
    outputEvidence: boolean;
    status: "healthy" | "reporting_degraded" | "stale" | "orphaned" | "error" | "offline" | "unknown";
    freshnessTimestamp: string | null;
    evidenceSource: string | null;
  };
  controls: { permittedIntents: []; pendingIntents: []; completedReceipts: [] };
  provenance: {
    sourceAuthority: "paperclip";
    observedAt: string;
    confidence: number;
    reconciliationDrift: true;
    driftDetails: string[];
  };
}

function mapIssueStatus(status: string): TaskStatus {
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
      return "blocked";
  }
}

function mapWorkUnitStatus(status: string): WorkUnitState {
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
    default:
      return "failed";
  }
}

function validRuntime(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) && value.length <= 64;
}

function validParticipant(
  participation: CoordinationProjectionSnapshot["participations"][number],
): boolean {
  return validRuntime(participation.runtime)
    && ["lead", "worker", "reviewer", "helper"].includes(participation.role)
    && ["mutate", "read", "review"].includes(participation.mode)
    && ["observe", "enforce_mutations"].includes(participation.enforcementMode)
    && Number.isFinite(participation.startedAt.getTime())
    && Number.isFinite(participation.lastSeenAt.getTime())
    && (participation.endedAt === null || Number.isFinite(participation.endedAt.getTime()));
}

function deriveCoordinationEvidence(
  participations: CoordinationProjectionSnapshot["participations"],
  now: Date,
): CoordinationEvidence {
  const active = participations.filter((item) => item.endedAt === null);
  if (active.length === 0) {
    return {
      health: {
        heartbeatAgeSeconds: null,
        processEvidence: false,
        outputEvidence: false,
        status: "offline",
        freshnessTimestamp: null,
        evidenceSource: "paperclip-db:no-active-participation-record",
      },
      confidence: 0,
      reconciliationDrift: true,
      driftDetails: [
        "No active persisted coordination participation is available.",
        "No independently persisted process-custody evidence is available.",
        "No independently persisted output-delivery evidence is available.",
      ],
    };
  }
  const mostRecent = active.reduce((latest, item) => item.lastSeenAt > latest ? item.lastSeenAt : latest, active[0].lastSeenAt);
  if (mostRecent > now) {
    return {
      health: {
        heartbeatAgeSeconds: null,
        processEvidence: false,
        outputEvidence: false,
        status: "error",
        freshnessTimestamp: mostRecent.toISOString(),
        evidenceSource: "paperclip-db:future-participation-heartbeat",
      },
      confidence: 0,
      reconciliationDrift: true,
      driftDetails: ["The most recent active participation heartbeat is in the future."],
    };
  }
  const age = Math.floor((now.getTime() - mostRecent.getTime()) / 1000);
  const status = age > 1800 ? "orphaned" : age > 300 ? "stale" : "reporting_degraded";
  return {
    health: {
      heartbeatAgeSeconds: age,
      processEvidence: false,
      outputEvidence: false,
      status,
      freshnessTimestamp: mostRecent.toISOString(),
      evidenceSource: "paperclip-db:participation-heartbeat-only",
    },
    confidence: 0,
    reconciliationDrift: true,
    driftDetails: [
      status === "reporting_degraded"
        ? "A fresh participation heartbeat proves reporting only."
        : "The active participation heartbeat is not fresh enough for reporting confidence.",
      "No independently persisted process-custody evidence is available.",
      "No independently persisted output-delivery evidence is available.",
    ],
  };
}

function participantView(
  participation: CoordinationProjectionSnapshot["participations"][number],
): Record<string, unknown> {
  return {
    id: participation.id,
    runtime: participation.runtime,
    role: participation.role,
    mode: participation.mode,
    enforcementMode: participation.enforcementMode,
    ...(participation.runId === null ? {} : { runId: participation.runId }),
    ...(participation.sessionId === null ? {} : { sessionId: participation.sessionId }),
    currentAction: participation.currentAction,
    progressNote: participation.progressNote,
    blocker: participation.blocker,
    nextAction: participation.nextAction,
    ...(participation.retryState === null ? {} : { retryState: participation.retryState }),
    startedAt: participation.startedAt.toISOString(),
    lastSeenAt: participation.lastSeenAt.toISOString(),
    endedAt: participation.endedAt?.toISOString() ?? null,
  };
}

function evidenceWithInvalidRows(
  evidence: CoordinationEvidence,
  invalidParticipantCount: number,
): CoordinationEvidence {
  if (invalidParticipantCount === 0) return evidence;
  return {
    health: {
      heartbeatAgeSeconds: null,
      processEvidence: false,
      outputEvidence: false,
      status: "error",
      freshnessTimestamp: null,
      evidenceSource: "paperclip-db:invalid-participation-evidence",
    },
    confidence: 0,
    reconciliationDrift: true,
    driftDetails: [
      `${invalidParticipantCount} persisted participation row(s) failed runtime evidence validation.`,
      "Malformed participation evidence is excluded from positive coordination claims.",
    ],
  };
}

function projectEvidence(
  snapshot: CoordinationProjectionSnapshot,
): { evidence: CoordinationEvidence; participants: Array<Record<string, unknown>> } {
  const valid = snapshot.participations.filter(validParticipant);
  const evidence = evidenceWithInvalidRows(
    deriveCoordinationEvidence(valid, snapshot.observedAt),
    snapshot.participations.length - valid.length,
  );
  return {
    evidence,
    participants: snapshot.participations.length === valid.length ? valid.map(participantView) : [],
  };
}

function projectView(
  snapshot: CoordinationProjectionSnapshot,
  actorAgentId: string | null,
): TaskCoordinationViewV2 {
  const generation = snapshot.rootIssue.coordinationGeneration;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("coordination_generation must be a positive persisted integer");
  }
  const persistedGeneration = generation;

  const { evidence, participants } = projectEvidence(snapshot);
  const agentMaySeePlacements = actorAgentId === null
    || snapshot.rootIssue.assigneeAgentId === actorAgentId
    || snapshot.participations.some((participation) => participation.agentId === actorAgentId);
  const activeLeases = snapshot.leases.filter((lease) => lease.status === "active");
  const view: TaskCoordinationViewV2 = {
    schemaVersion: "task-coordination.v2",
    task: {
      canonicalKey: null,
      githubProjectItemId: null,
      mckTaskId: null,
      paperclipParentIssueId: snapshot.rootIssue.id,
      correlationId: snapshot.rootIssue.id,
      status: mapIssueStatus(snapshot.rootIssue.status),
      accountableLead: snapshot.rootIssue.assigneeAgentId ?? "unassigned",
      generation: persistedGeneration,
      createdAt: snapshot.rootIssue.createdAt.toISOString(),
      updatedAt: snapshot.rootIssue.updatedAt.toISOString(),
    },
    workUnits: snapshot.childIssues.map((child) => {
      const lease = activeLeases.find((item) => item.issueId === child.id);
      return {
        id: child.id,
        paperclipChildIssueId: child.id,
        githubChildIssueId: null,
        owner: child.assigneeAgentId ?? "unassigned",
        acceptanceCriteria: child.description ? [child.description] : [],
        tests: [],
        mutationScope: {
          repositories: lease?.scopeRepositories ?? [],
          paths: lease?.scopePaths ?? [],
        },
        state: mapWorkUnitStatus(child.status),
      };
    }),
    participants,
    placements: agentMaySeePlacements
      ? snapshot.hosts.map((host) => ({
        hostId: host.hostId,
        hostname: host.hostname,
        os: host.os,
        runtime: host.runtime,
        ...(host.reachableAddresses && host.reachableAddresses.length > 0
          ? { reachableAddresses: [...new Set(host.reachableAddresses)] }
          : {}),
        ...(host.environment ? { environment: host.environment } : {}),
      }))
      : [],
    delivery: { commits: [], pullRequests: [] },
    health: evidence.health,
    controls: { permittedIntents: [], pendingIntents: [], completedReceipts: [] },
    provenance: {
      sourceAuthority: "paperclip",
      observedAt: snapshot.observedAt.toISOString(),
      confidence: evidence.confidence,
      reconciliationDrift: true,
      driftDetails: evidence.driftDetails,
    },
  };

  if (!validateSchema(view)) {
    const errors = (validateSchema.errors ?? []) as ErrorObject[];
    throw new Error(`task-coordination.v2 validation failed: ${ajv.errorsText(errors)}`);
  }
  return view;
}

export function projectTaskCoordinationViewV2(
  snapshot: CoordinationProjectionSnapshot,
  actorAgentId: string | null = null,
): TaskCoordinationViewV2 {
  return projectView(snapshot, actorAgentId);
}

export async function getIssueCoordinationV2(
  db: Db,
  rootIssueId: string,
  companyId: string,
  actorAgentId: string | null = null,
): Promise<TaskCoordinationViewV2 | null> {
  const snapshot = await loadIssueCoordinationSnapshot(db, rootIssueId, companyId);
  return snapshot ? projectTaskCoordinationViewV2(snapshot, actorAgentId) : null;
}
