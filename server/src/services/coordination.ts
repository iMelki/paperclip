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
import {
  projectTaskCoordinationView,
  type CoordinationProjectionSnapshot,
  type TaskCoordinationView,
} from "./coordination-projection.js";

export type { TaskCoordinationView } from "./coordination-projection.js";

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

// Loader helpers stay private so production callers cannot bypass the
// mandatory company scope and project arbitrary cross-company rows.
async function loadCompanyScopedCoordinationRows(
  db: Db,
  allIssueIds: string[],
  rootIssueId: string,
  companyId: string,
): Promise<Pick<CoordinationProjectionSnapshot, "participations" | "leases" | "intents">> {
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
      eq(controlIntents.rootIssueId, rootIssueId),
      eq(controlIntents.companyId, companyId),
    ));
  return { participations, leases, intents };
}

async function loadCoordinationHosts(
  db: Db,
  companyId: string,
  participations: CoordinationProjectionSnapshot["participations"],
): Promise<CoordinationProjectionSnapshot["hosts"]> {
  const agentInstanceIds = [
    ...new Set(
      participations
        .map((participation) => participation.agentInstanceId)
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
        .map((instance) => instance.hostNodeId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  return hostNodeIds.length > 0
    ? db.select().from(hostNodes).where(and(
      inArray(hostNodes.id, hostNodeIds),
      eq(hostNodes.companyId, companyId),
    ))
    : [];
}

async function loadIssueCoordinationSnapshot(
  db: Db,
  rootIssueId: string,
  companyId: string,
): Promise<CoordinationProjectionSnapshot | null> {
  const rootIssue = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!rootIssue) {
    return null;
  }
  const childIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.parentId, rootIssueId), eq(issues.companyId, companyId)));
  const allIssueIds = [rootIssue.id, ...childIssues.map((c) => c.id)];
  const rows = await loadCompanyScopedCoordinationRows(db, allIssueIds, rootIssue.id, companyId);
  const hosts = await loadCoordinationHosts(db, companyId, rows.participations);
  return {
    observedAt: new Date(),
    rootIssue,
    childIssues,
    ...rows,
    hosts,
  };
}

export async function getIssueCoordination(
  db: Db,
  rootIssueId: string,
  companyId: string,
): Promise<TaskCoordinationView | null> {
  const snapshot = await loadIssueCoordinationSnapshot(db, rootIssueId, companyId);
  return snapshot ? projectTaskCoordinationView(snapshot) : null;
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
