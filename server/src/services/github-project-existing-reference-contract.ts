import { z } from "zod";
import { conflict } from "../errors.js";
import { boardImportDigest, validateBoardImportSourceUrl, type BoardImportIntent } from "./plugin-imported-issues-contract.js";

export const EXISTING_BOARD_REFERENCE_TYPE = "paperclip-github-plugin.board-issue-reference";
export const EXISTING_BOARD_REFERENCE_ORIGIN = "plugin:paperclip-github-plugin:github-issue";
const uuid = z.string().uuid(), node = z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const existingReferenceDataSchema = z.object({
  version: z.literal(1), companyId: uuid, projectId: uuid, boardId: node, boardItemId: node,
  githubIssueNodeId: node, taskId: uuid, sourceUrl: z.string().max(2048), boardUrl: z.string().max(2048),
  sourceUpdatedAt: z.string().datetime(),
  fields: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(4096) }).strict()).max(100),
  mode: z.literal("reference-existing"), issueWrites: z.literal(0), agentDispatchRequests: z.literal(0),
}).strict();
export type ExistingReferenceData = z.infer<typeof existingReferenceDataSchema>;

/** Reconstruct the writer's property order; JSONB object-key order is not provenance. */
export function existingReferenceKey(data: ExistingReferenceData) {
  const snapshot = { version: 1, companyId: data.companyId, projectId: data.projectId, boardId: data.boardId,
    boardItemId: data.boardItemId, githubIssueNodeId: data.githubIssueNodeId, taskId: data.taskId,
    sourceUrl: data.sourceUrl, boardUrl: data.boardUrl, sourceUpdatedAt: data.sourceUpdatedAt,
    fields: data.fields.map(field => ({ name: field.name, value: field.value })),
    mode: "reference-existing", issueWrites: 0, agentDispatchRequests: 0 };
  return boardImportDigest(["board-existing-reference-v1", snapshot]);
}
const witnessSchema = z.object({
  kind: z.literal("preserved-existing-board-reference"), version: z.literal(1),
  pluginId: uuid, companyId: uuid, projectId: uuid, boardId: node, boardItemId: node,
  githubIssueNodeId: node, taskId: uuid, sourceUrl: z.string().max(2048), boardUrl: z.string().max(2048),
  operationId: digest, intentHash: digest, referenceId: uuid, referenceKey: digest, referenceDigest: digest,
  referenceIds: z.array(uuid).min(1).max(1000), referenceKeys: z.array(digest).min(1).max(1000),
  issueWrites: z.literal(0), agentDispatchRequests: z.literal(0),
  taskState: z.object({ status: z.string().min(1), assigneeAgentId: uuid.nullable(),
    assigneeUserId: z.string().nullable(), parentId: uuid.nullable() }).strict(),
}).strict();
export type ExistingBoardReferenceWitness = z.infer<typeof witnessSchema>;
export function assertExistingBoardReferenceWitness(intent: BoardImportIntent, value: unknown): ExistingBoardReferenceWitness {
  const parsed = witnessSchema.safeParse(value);
  if (!parsed.success) throw conflict("Invalid existing board reference witness");
  const witness = parsed.data;
  validateBoardImportSourceUrl(witness.sourceUrl);
  if (witness.companyId !== intent.companyId || witness.projectId !== intent.projectId
    || witness.boardId !== intent.boardId || witness.boardItemId !== intent.boardItemId
    || witness.githubIssueNodeId !== intent.githubIssueNodeId || witness.boardUrl !== intent.boardUrl
    || witness.sourceUrl.toLowerCase() !== intent.task.sourceUrl.toLowerCase()
    || witness.operationId !== intent.operationId || witness.intentHash !== intent.intentHash
    || witness.referenceIds.length !== witness.referenceKeys.length
    || new Set(witness.referenceIds).size !== witness.referenceIds.length
    || new Set(witness.referenceKeys).size !== witness.referenceKeys.length
    || witness.referenceId !== witness.referenceIds[0] || witness.referenceKey !== witness.referenceKeys[0]
    || witness.referenceKeys.some((key, index) => index > 0 && key <= witness.referenceKeys[index - 1])
    || witness.referenceDigest !== boardImportDigest(["verified-existing-reference-set-v1", witness.referenceKeys])) {
    throw conflict("Existing board reference witness identity mismatch");
  }
  return witness;
}
