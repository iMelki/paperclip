import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, pluginEntities, projects } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import type { VerifiedScheduledBoard } from "./github-project-scheduled-contract.js";
import { parseGitHubProjectBoardUrl } from "./github-oauth-project-page.js";
import { boardImportDigest, validateBoardImportIntent, validateBoardImportSourceUrl,
  type BoardImportIntent } from "./plugin-imported-issues-contract.js";
import { assertExistingBoardReferenceWitness, existingReferenceDataSchema, existingReferenceKey,
  EXISTING_BOARD_REFERENCE_ORIGIN, EXISTING_BOARD_REFERENCE_TYPE,
  type ExistingBoardReferenceWitness, type ExistingReferenceData } from "./github-project-existing-reference-contract.js";
export { assertExistingBoardReferenceWitness, type ExistingBoardReferenceWitness } from "./github-project-existing-reference-contract.js";

type ReferenceRow = typeof pluginEntities.$inferSelect;
type VerifiedReference = { row: ReferenceRow; data: ExistingReferenceData };
const MAX_REFERENCES = 1000;
function checkedReference(row: ReferenceRow, pluginId: string, companyId: string): VerifiedReference {
  const parsed = existingReferenceDataSchema.safeParse(row.data);
  if (!parsed.success || row.pluginId !== pluginId || row.entityType !== EXISTING_BOARD_REFERENCE_TYPE
    || row.scopeKind !== "company" || row.scopeId !== companyId
    || (row.companyId !== null && row.companyId !== companyId) || parsed.data.companyId !== companyId
    || row.externalId !== existingReferenceKey(parsed.data)) {
    throw conflict("Malformed or foreign existing board reference; records preserved");
  }
  validateBoardImportSourceUrl(parsed.data.sourceUrl);
  parseGitHubProjectBoardUrl(parsed.data.boardUrl);
  return { row, data: parsed.data };
}
function matchesIdentity(data: ExistingReferenceData, intent: BoardImportIntent) {
  return data.projectId === intent.projectId && data.boardId === intent.boardId && data.boardItemId === intent.boardItemId
    && data.githubIssueNodeId === intent.githubIssueNodeId && data.boardUrl === intent.boardUrl
    && data.sourceUrl.toLowerCase() === intent.task.sourceUrl.toLowerCase();
}
function related(data: ExistingReferenceData, intent: BoardImportIntent) {
  return data.boardItemId === intent.boardItemId || (data.boardId === intent.boardId
    && (data.githubIssueNodeId === intent.githubIssueNodeId || data.sourceUrl.toLowerCase() === intent.task.sourceUrl.toLowerCase()));
}
function checkScope(identity: { pluginId: string; pluginKey: string }, verified: Readonly<VerifiedScheduledBoard>, value: BoardImportIntent) {
  const intent = validateBoardImportIntent(value, verified.target.companyId);
  if (identity.pluginKey !== "paperclip-github-plugin" || identity.pluginId !== verified.target.pluginId
    || verified.target.projectId !== intent.projectId || verified.binding.companyId !== intent.companyId
    || verified.binding.projectId !== intent.projectId || verified.binding.boardId !== intent.boardId
    || verified.binding.boardUrl !== intent.boardUrl) throw forbidden("Verified existing board reference scope required");
  return intent;
}

/** Caller must supply its existing bounded checkpoint transaction and revalidate native authority around this read.
 * No issue service, issue writes, root/hold changes, assignments, heartbeat or dispatch methods exist here. */
export async function readVerifiedExistingBoardReference(executor: Db, identity: { pluginId: string; pluginKey: string },
  verified: Readonly<VerifiedScheduledBoard>, value: BoardImportIntent): Promise<Readonly<ExistingBoardReferenceWitness> | null> {
  const intent = checkScope(identity, verified, value), companyId = intent.companyId;
  const rows = await executor.select().from(pluginEntities).where(and(
    eq(pluginEntities.pluginId, identity.pluginId), eq(pluginEntities.entityType, EXISTING_BOARD_REFERENCE_TYPE),
    or(eq(pluginEntities.companyId, companyId), eq(pluginEntities.scopeId, companyId),
      sql`${pluginEntities.data}->>'companyId' = ${companyId}`),
  )).limit(MAX_REFERENCES + 1).for("share");
  if (rows.length > MAX_REFERENCES) throw conflict("Existing board reference read exceeded its bound");
  const references = rows.map(row => checkedReference(row, identity.pluginId, companyId))
    .filter(({ data }) => related(data, intent));
  if (!references.length) return null;
  if (references.some(({ data }) => !matchesIdentity(data, intent))
    || new Set(references.map(({ data }) => data.taskId)).size !== 1) {
    throw conflict("Ambiguous existing board reference identity; tasks preserved");
  }
  const projectRows = await executor.select({ id: projects.id }).from(projects).where(and(
    eq(projects.id, intent.projectId), eq(projects.companyId, companyId), sql`${projects.archivedAt} is null`,
  )).limit(2).for("share");
  const taskId = references[0].data.taskId;
  const taskRows = await executor.select().from(issues).where(and(eq(issues.companyId, companyId),
    or(eq(issues.id, taskId), sql`lower(${issues.originId}) = ${intent.task.sourceUrl.toLowerCase()}`),
  )).limit(3).for("share");
  const task = taskRows[0];
  if (projectRows.length !== 1 || taskRows.length !== 1 || !task || task.id !== taskId
    || task.companyId !== companyId || task.projectId !== intent.projectId
    || task.originKind !== EXISTING_BOARD_REFERENCE_ORIGIN
    || typeof task.originId !== "string" || task.originId.toLowerCase() !== intent.task.sourceUrl.toLowerCase()) {
    throw conflict("Existing task identity or ownership changed; task preserved");
  }
  references.sort((a, b) => a.row.externalId!.localeCompare(b.row.externalId!));
  const referenceIds = references.map(({ row }) => row.id), referenceKeys = references.map(({ row }) => row.externalId!);
  return Object.freeze(assertExistingBoardReferenceWitness(intent, {
    kind: "preserved-existing-board-reference", version: 1, pluginId: identity.pluginId,
    companyId, projectId: intent.projectId, boardId: intent.boardId, boardItemId: intent.boardItemId,
    githubIssueNodeId: intent.githubIssueNodeId, taskId, sourceUrl: intent.task.sourceUrl, boardUrl: intent.boardUrl,
    operationId: intent.operationId, intentHash: intent.intentHash,
    referenceId: referenceIds[0], referenceKey: referenceKeys[0], referenceIds, referenceKeys,
    referenceDigest: boardImportDigest(["verified-existing-reference-set-v1", referenceKeys]),
    issueWrites: 0, agentDispatchRequests: 0, taskState: { status: task.status,
      assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId, parentId: task.parentId },
  }));
}
