import { createHash } from "node:crypto";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";

export const BOARD_IMPORT_PROTOCOL = "paperclip-github-board-import/v1" as const;
export const BOARD_IMPORT_NAMESPACE = "host-github-board-import-v1";
export const BOARD_IMPORT_ROOT_TITLE = "GitHub board imports — manual backlog";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nodeSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_=-]+$/);
const fieldSchema = z.object({ name: z.string().min(1).max(128), value: z.string().max(4096) }).strict();
const canonicalUrl = (pattern: RegExp) => z.string().max(2048).superRefine((value, ctx) => {
  let valid = false;
  try {
    const url = new URL(value);
    valid = url.protocol === "https:" && url.hostname === "github.com" && !url.port
      && !url.username && !url.password && !url.search && !url.hash && url.href === value
      && pattern.test(url.pathname);
  } catch { /* Invalid URLs are denied without reflecting their contents. */ }
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid canonical GitHub URL" });
});
const boardUrlSchema = canonicalUrl(/^\/(?:users|orgs)\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/projects\/[1-9]\d*$/);
const sourceUrlSchema = canonicalUrl(/^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/);
const taskSchema = z.object({
  companyId: z.string().uuid(), projectId: z.string().uuid(), githubIssueNodeId: nodeSchema,
  title: z.string().min(1).max(4096), sourceUrl: sourceUrlSchema, status: z.literal("backlog"),
  assigneeAgentId: z.null(), assigneeUserId: z.null(), noDispatch: z.literal(true),
}).strict();
const intentSchema = z.object({
  operationId: digestSchema, intentHash: digestSchema, companyId: z.string().uuid(), projectId: z.string().uuid(),
  taskKey: digestSchema, membershipKey: digestSchema, boardId: nodeSchema, boardItemId: nodeSchema,
  githubIssueNodeId: nodeSchema, boardUrl: boardUrlSchema, sourceUpdatedAt: z.string().datetime(),
  task: taskSchema, fields: z.array(fieldSchema).max(100),
}).strict();

/** Context is supplied by the native invocation registry, never by worker params. */
export interface BoardImportHostContext {
  companyId: string;
  actor: { type: "user" | "agent" | "system"; userId?: string | null };
}
export type BoardImportIntent = z.infer<typeof intentSchema>;
export type BoardImportTask = Omit<z.infer<typeof taskSchema>, "noDispatch"> & { id: string; noDispatch: boolean };
export interface BoardImportOperation {
  operationId: string; intentHash: string; companyId: string; state: "prepared" | "committed";
}
export interface BoardImportMembership {
  key: string; companyId: string; projectId: string; boardId: string; boardItemId: string;
  githubIssueNodeId: string; taskId: string; boardUrl: string; sourceUpdatedAt: string;
  fields: BoardImportIntent["fields"];
}
export interface BoardImportReceipt {
  operationId: string; task: BoardImportTask; membership: BoardImportMembership; createdTask: boolean;
}
export const boardImportDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const boardImportOrigins = (pluginKey: string) => ({
  task: `plugin:${pluginKey}:github-board-manual`, root: `plugin:${pluginKey}:github-board-quarantine`,
});

export function validateBoardImportContext(context: BoardImportHostContext, requireUser = true): string | null {
  if (!z.string().uuid().safeParse(context?.companyId).success) throw forbidden("Trusted company scope required");
  if (!context.actor || !["user", "agent", "system"].includes(context.actor.type)) {
    throw forbidden("Trusted actor scope required");
  }
  const userId = context.actor.userId;
  if (requireUser && (context.actor.type !== "user" || typeof userId !== "string"
    || !userId.trim() || userId !== userId.trim() || userId.length > 256)) {
    throw forbidden("A signed-in operator is required for board import");
  }
  return typeof userId === "string" ? userId : null;
}

export function validateBoardImportIntent(value: unknown, companyId: string): BoardImportIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) throw unprocessable("Invalid bounded board import intent");
  const input = parsed.data;
  const task = { companyId: input.companyId, projectId: input.projectId, githubIssueNodeId: input.githubIssueNodeId,
    title: input.task.title, sourceUrl: input.task.sourceUrl, status: "backlog" as const,
    assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const };
  const data = { companyId: input.companyId, projectId: input.projectId,
    taskKey: boardImportDigest(["github-issue", input.companyId, input.githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", input.companyId, input.boardId, input.boardItemId]),
    boardId: input.boardId, boardItemId: input.boardItemId, githubIssueNodeId: input.githubIssueNodeId,
    boardUrl: input.boardUrl, sourceUpdatedAt: input.sourceUpdatedAt, task, fields: input.fields };
  const intentHash = boardImportDigest(["board-import-v1", data]);
  if (input.companyId !== companyId || input.task.companyId !== companyId
    || input.task.projectId !== input.projectId || input.task.githubIssueNodeId !== input.githubIssueNodeId
    || input.taskKey !== data.taskKey || input.membershipKey !== data.membershipKey
    || input.intentHash !== intentHash || input.operationId !== intentHash) {
    throw unprocessable("Board import identity, scope or intent hash mismatch");
  }
  return { ...data, intentHash, operationId: intentHash };
}

export function validateBoardImportNode(value: string) {
  if (!nodeSchema.safeParse(value).success) throw unprocessable("Invalid GitHub issue node ID");
  return value;
}
export function validateBoardImportOperationId(value: string) {
  if (!digestSchema.safeParse(value).success) throw unprocessable("Invalid board import operation ID");
  return value;
}
export function validateBoardImportSourceUrl(value: string) {
  if (!sourceUrlSchema.safeParse(value).success) throw unprocessable("Invalid canonical GitHub issue URL");
  return value;
}
