import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, issueTreeHolds, issues, pluginEntities, plugins, pluginState, projects } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { pluginStateStore } from "./plugin-state-store.js";
import {
  BOARD_IMPORT_NAMESPACE, BOARD_IMPORT_PROTOCOL, BOARD_IMPORT_ROOT_TITLE, boardImportDigest, boardImportOrigins,
  validateBoardImportContext, validateBoardImportIntent, validateBoardImportNode, validateBoardImportOperationId,
  validateBoardImportSourceUrl,
  type BoardImportHostContext, type BoardImportIntent, type BoardImportMembership, type BoardImportOperation,
  type BoardImportReceipt, type BoardImportTask,
} from "./plugin-imported-issues-contract.js";

type NativeIssue = typeof issues.$inferSelect;
type RootJournal = { rootId: string; holdId: string; projectId: string };
type TaskJournal = RootJournal & { taskId: string; nodeId: string; sourceUrl: string; title: string };
type StoredOperation = BoardImportOperation & {
  userId: string; intent: BoardImportIntent; receipt?: BoardImportReceipt;
};
const MAX_EXCLUSIONS = 1000;
export type BoardImportIntentValidation = (
  executor: Db, context: BoardImportHostContext, intent: BoardImportIntent,
) => Promise<void>;

/** Native company-scoped import only. No worker-selected executor or dispatch methods are accepted. */
export function pluginImportedIssuesService(
  db: Db, identity: { pluginId: string; pluginKey: string }, validateIntent?: BoardImportIntentValidation,
) {
  const origins = boardImportOrigins(identity.pluginKey);
  const taskKey = (companyId: string, node: string) => boardImportDigest(["github-issue", companyId, node]);
  const state = (executor: Db) => pluginStateStore(executor);
  const readState = async <T>(executor: Db, companyId: string, key: string): Promise<T | null> => {
    const value = await state(executor).get(identity.pluginId, "company", key,
      { scopeId: companyId, namespace: BOARD_IMPORT_NAMESPACE });
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw conflict("Invalid retained board import record");
    return value as T;
  };
  const writeState = (executor: Db, companyId: string, key: string, value: unknown) => state(executor).set(identity.pluginId,
    { scopeKind: "company", scopeId: companyId, namespace: BOARD_IMPORT_NAMESPACE, stateKey: key, value });
  const transact = <T>(action: (executor: Db) => Promise<T>) => db.transaction(async tx => {
    const executor = tx as unknown as Db;
    const startedAt = Date.now();
    await executor.execute(sql`set local statement_timeout = '10000ms'`);
    await executor.execute(sql`set local lock_timeout = '5000ms'`);
    const result = await action(executor);
    if (Date.now() - startedAt > 20000) throw conflict("Board import transaction exceeded its bounded deadline");
    return result;
  });
  const lock = async (executor: Db, key: string) => {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  };
  const audit = (executor: Db, context: BoardImportHostContext, action: string, entityId: string,
    details: Record<string, unknown>) => persistActivity(executor, {
    companyId: context.companyId, actorType: "user", actorId: context.actor.userId!, action,
    entityType: "plugin_board_import", entityId, details,
  });

  async function authorize(executor: Db, context: BoardImportHostContext, projectId?: string, allowJob = false) {
    const userId = validateBoardImportContext(context, !allowJob);
    const plugin = await executor.select().from(plugins).where(eq(plugins.id, identity.pluginId)).for("share")
      .then(rows => rows[0] ?? null);
    if (!plugin || plugin.pluginKey !== identity.pluginKey || !["installed", "ready"].includes(plugin.status)) {
      throw forbidden("Installed board import plugin required");
    }
    if (context.actor.type === "user") {
      if (!userId) throw forbidden("A signed-in operator is required");
      const membership = await executor.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, context.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
      )).for("share").then(rows => rows[0] ?? null);
      if (!membership || membership.membershipRole === "viewer") throw forbidden("Active operator membership required");
    }
    if (projectId) {
      const project = await executor.select().from(projects).where(and(
        eq(projects.id, projectId), eq(projects.companyId, context.companyId), isNull(projects.archivedAt),
      )).for("share").then(rows => rows[0] ?? null);
      if (!project) throw forbidden("Existing destination project in the trusted company required");
    }
    return userId;
  }

  function neutral(issue: NativeIssue) {
    return issue.status === "backlog" && issue.assigneeAgentId === null && issue.assigneeUserId === null
      && issue.hiddenAt === null && issue.checkoutRunId === null && issue.executionRunId === null
      && issue.executionPolicy === null && issue.executionState === null && issue.monitorNextCheckAt === null
      && issue.monitorWakeRequestedAt === null && issue.assigneeAdapterOverrides === null;
  }
  async function nativeIssue(executor: Db, companyId: string, id: string, locked = false) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw conflict("Invalid retained task identity");
    const query = executor.select().from(issues).where(and(eq(issues.id, id), eq(issues.companyId, companyId)));
    const rows = await query.for(locked ? "update" : "share");
    return rows[0] ?? null;
  }
  async function verifyRoot(executor: Db, companyId: string, journal: RootJournal, locked = false) {
    const root = await nativeIssue(executor, companyId, journal.rootId, locked);
    const query = executor.select().from(issueTreeHolds).where(and(
      eq(issueTreeHolds.id, journal.holdId), eq(issueTreeHolds.companyId, companyId),
      eq(issueTreeHolds.rootIssueId, journal.rootId), eq(issueTreeHolds.mode, "pause"), eq(issueTreeHolds.status, "active"),
    ));
    const hold = await query.for(locked ? "update" : "share").then(rows => rows[0] ?? null);
    return Boolean(root && neutral(root) && root.parentId === null && root.projectId === journal.projectId
      && root.title === BOARD_IMPORT_ROOT_TITLE && root.originKind === origins.root && root.originId === journal.projectId
      && hold && hold.releasePolicy?.strategy === "manual");
  }
  async function ensureRoot(executor: Db, context: BoardImportHostContext, projectId: string): Promise<RootJournal> {
    await lock(executor, `board-import:root:${context.companyId}:${projectId}`);
    const retained = await readState<RootJournal>(executor, context.companyId, `root:${projectId}`);
    if (retained) {
      if (retained.projectId !== projectId || !await verifyRoot(executor, context.companyId, retained, true)) {
        throw conflict("Import parent or manual pause hold changed; preserve it and inspect before importing");
      }
      return retained;
    }
    const orphan = await executor.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, context.companyId), eq(issues.originKind, origins.root), eq(issues.originId, projectId),
    )).limit(1);
    if (orphan.length) throw conflict("Import parent exists without its native journal; inspect before importing");
    const root = await issueService(executor).create(context.companyId, {
      id: randomUUID(), projectId, parentId: null, title: BOARD_IMPORT_ROOT_TITLE,
      description: "Imported GitHub board tasks are held here. Import does not authorize agent execution.",
      status: "backlog", assigneeAgentId: null, assigneeUserId: null, executionPolicy: null,
      createdByUserId: context.actor.userId, allowDuplicate: true, skipExecutionWorkspaceInheritance: true,
      originKind: origins.root, originId: projectId,
    });
    const { hold } = await issueTreeControlService(executor).createHold(context.companyId, root.id, {
      mode: "pause", reason: "GitHub board import is manual and does not authorize agent execution",
      releasePolicy: { strategy: "manual", note: "Explicit operator release is separate from board synchronization" },
      actor: { actorType: "user", actorId: context.actor.userId!, userId: context.actor.userId },
    });
    const journal = { rootId: root.id, holdId: hold.id, projectId };
    await writeState(executor, context.companyId, `root:${projectId}`, journal);
    await audit(executor, context, "plugin.board_import.root_prepared", root.id, { projectId, holdId: hold.id });
    return journal;
  }

  async function taskJournal(executor: Db, companyId: string, node: string, locked = false) {
    const journal = await readState<TaskJournal>(executor, companyId, `task:${taskKey(companyId, node)}`);
    const rows = await executor.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.originKind, origins.task), eq(issues.originId, node),
    )).limit(2).for(locked ? "update" : "share");
    if (rows.length > 1 || (!journal && rows.length)) throw conflict("Ambiguous or unjournaled native GitHub task");
    if (!journal) return null;
    validateBoardImportSourceUrl(journal.sourceUrl);
    const issue = rows[0];
    if (!issue || journal.nodeId !== node || issue.id !== journal.taskId || issue.projectId !== journal.projectId
      || issue.parentId !== journal.rootId || issue.originFingerprint !== journal.sourceUrl) {
      throw conflict("Native GitHub task identity changed; existing work preserved");
    }
    return { journal, issue };
  }
  async function taskReadback(executor: Db, companyId: string, node: string): Promise<BoardImportTask | null> {
    const existing = await taskJournal(executor, companyId, node);
    if (!existing) return null;
    const { journal, issue } = existing;
    if (!neutral(issue) || issue.title !== journal.title) throw conflict("Imported task was edited or activated; preserved");
    return { id: issue.id, companyId, projectId: journal.projectId, githubIssueNodeId: node,
      title: issue.title, sourceUrl: issue.originFingerprint, status: "backlog", assigneeAgentId: null,
      assigneeUserId: null, noDispatch: await verifyRoot(executor, companyId, journal) };
  }
  async function operation(executor: Db, context: BoardImportHostContext, operationId: string) {
    const value = await readState<StoredOperation>(executor, context.companyId, `operation:${operationId}`);
    if (!value) return null;
    if (value.userId !== context.actor.userId || value.companyId !== context.companyId || value.operationId !== operationId
      || !["prepared", "committed"].includes(value.state)) throw conflict("Retained operation ownership mismatch");
    const intent = validateBoardImportIntent(value.intent, context.companyId);
    if (intent.operationId !== operationId || value.intentHash !== intent.intentHash) throw conflict("Retained operation mismatch");
    return value;
  }
  async function rejectLegacy(executor: Db, companyId: string, intent: BoardImportIntent, ownId?: string) {
    const native = await executor.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), or(
      sql`lower(${issues.originId}) = ${intent.task.sourceUrl.toLowerCase()}`,
      and(eq(issues.originId, intent.githubIssueNodeId), like(issues.originKind, "plugin:%:github-board-manual"),
        ne(issues.originKind, origins.task)),
    ))).limit(2);
    const linked = await executor.select({ id: pluginEntities.id }).from(pluginEntities).where(and(
      eq(pluginEntities.pluginId, identity.pluginId),
      or(eq(pluginEntities.companyId, companyId), and(isNull(pluginEntities.companyId),
        sql`${pluginEntities.data}->>'companyId' = ${companyId}`)),
      or(sql`lower(${pluginEntities.data}->>'githubIssueUrl') = ${intent.task.sourceUrl.toLowerCase()}`,
        sql`${pluginEntities.data}->>'githubIssueNodeId' = ${intent.githubIssueNodeId}`),
    )).limit(1);
    if (native.some(row => row.id !== ownId) || linked.length) {
      throw conflict("This GitHub issue has an existing repository-sync mapping; preserve it and resolve the mapping first");
    }
  }
  async function createOrRecoverTask(executor: Db, context: BoardImportHostContext, intent: BoardImportIntent) {
    const existing = await taskJournal(executor, context.companyId, intent.githubIssueNodeId, true);
    await rejectLegacy(executor, context.companyId, intent, existing?.issue.id);
    if (existing) {
      const { journal, issue } = existing;
      if (journal.projectId !== intent.projectId
        || journal.sourceUrl !== intent.task.sourceUrl || !neutral(issue) || issue.title !== journal.title
        || !await verifyRoot(executor, context.companyId, journal, true)) {
        throw conflict("Existing imported task differs from this neutral import; work preserved");
      }
      if (journal.title !== intent.task.title) {
        const updated = await issueService(executor).update(issue.id, {
          title: intent.task.title, actorUserId: context.actor.userId,
        }, executor, []);
        if (!updated || updated.title !== intent.task.title) throw conflict("Source-title update was not verified");
        journal.title = intent.task.title;
        await writeState(executor, context.companyId, `task:${intent.taskKey}`, journal);
      }
      return { journal, taskId: issue.id, createdTask: false };
    }
    const root = await ensureRoot(executor, context, intent.projectId);
    const issue = await issueService(executor).create(context.companyId, {
      id: randomUUID(), projectId: intent.projectId, parentId: root.rootId,
      title: intent.task.title, description: `GitHub source: ${intent.task.sourceUrl}\n\nBoard metadata is reference only; agent execution remains held.`,
      status: "backlog", assigneeAgentId: null, assigneeUserId: null, executionPolicy: null,
      createdByUserId: context.actor.userId, allowDuplicate: true, skipExecutionWorkspaceInheritance: true,
      originKind: origins.task, originId: intent.githubIssueNodeId, originFingerprint: intent.task.sourceUrl,
    });
    const journal: TaskJournal = { ...root, taskId: issue.id, nodeId: intent.githubIssueNodeId,
      sourceUrl: intent.task.sourceUrl, title: intent.task.title };
    await writeState(executor, context.companyId, `task:${intent.taskKey}`, journal);
    return { journal, taskId: issue.id, createdTask: true };
  }
  async function readReceiptInside(executor: Db, context: BoardImportHostContext, operationId: string) {
    const saved = await operation(executor, context, operationId);
    if (!saved || saved.state !== "committed" || !saved.receipt) return null;
    const task = await taskReadback(executor, context.companyId, saved.intent.githubIssueNodeId);
    const membership = await readState<BoardImportMembership>(executor, context.companyId, `membership:${saved.intent.membershipKey}`);
    if (!task || !membership || task.id !== saved.receipt.task.id || !isDeepStrictEqual(membership, saved.receipt.membership)
      || !isDeepStrictEqual({ ...task, noDispatch: true }, saved.receipt.task)) {
      throw conflict("Current native task or board membership no longer matches the committed import");
    }
    return { ...saved.receipt, task, membership };
  }
  const read = <T>(context: BoardImportHostContext, action: (executor: Db) => Promise<T>) => transact(async executor => {
    await authorize(executor, context);
    return action(executor);
  });
  /** Native-only wrapper for stock GitHub issue creation; never exposed as a worker-selected callback. */
  async function withStockCreationFence<T>(companyId: string, sourceUrl: string, action: (executor: Db) => Promise<T>) {
    validateBoardImportSourceUrl(sourceUrl);
    const context: BoardImportHostContext = { companyId, actor: { type: "system" } };
    return transact(async executor => {
      await authorize(executor, context, undefined, true);
      await lock(executor, `board-import:source:${companyId}:${sourceUrl.toLowerCase()}`);
      const native = await executor.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, companyId), like(issues.originKind, "plugin:%:github-board-manual"),
        sql`lower(${issues.originFingerprint}) = ${sourceUrl.toLowerCase()}`,
      )).limit(1);
      const journal = await executor.select({ id: pluginState.id }).from(pluginState).where(and(
        eq(pluginState.pluginId, identity.pluginId), eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, companyId), eq(pluginState.namespace, BOARD_IMPORT_NAMESPACE),
        like(pluginState.stateKey, "task:%"), sql`lower(${pluginState.valueJson}->>'sourceUrl') = ${sourceUrl.toLowerCase()}`,
      )).limit(1);
      if (native.length || journal.length) {
        throw conflict("Manual board-import source excluded from repository sync", { code: "manual_board_import_excluded" });
      }
      return action(executor);
    });
  }

  return {
    capabilities: (context: BoardImportHostContext) => read(context, async () => ({ protocol: BOARD_IMPORT_PROTOCOL,
      atomicTaskAndMembershipUpsert: true, durableNoDispatch: true, atomicOperationIntent: true })),
    readTask: (context: BoardImportHostContext, input: { githubIssueNodeId: string }) => read(context,
      executor => taskReadback(executor, context.companyId, validateBoardImportNode(input.githubIssueNodeId))),
    readOperation: (context: BoardImportHostContext, input: { operationId: string }) => read(context, async executor => {
      const value = await operation(executor, context, validateBoardImportOperationId(input.operationId));
      return value ? { operationId: value.operationId, intentHash: value.intentHash, companyId: value.companyId,
        projectId: value.intent.projectId, intent: value.intent, state: value.state } : null;
    }),
    begin: (context: BoardImportHostContext, input: { intent: unknown }) => read(context, async executor => {
      const intent = validateBoardImportIntent(input.intent, context.companyId);
      await authorize(executor, context, intent.projectId);
      // Native construction only. Authorization and writes share this transaction and executor.
      await validateIntent?.(executor, context, intent);
      await lock(executor, `board-import:operation:${context.companyId}:${intent.operationId}`);
      if (await operation(executor, context, intent.operationId)) return false;
      await writeState(executor, context.companyId, `operation:${intent.operationId}`, {
        operationId: intent.operationId, intentHash: intent.intentHash, companyId: context.companyId,
        state: "prepared", userId: context.actor.userId!, intent,
      } satisfies StoredOperation);
      await audit(executor, context, "plugin.board_import.intent_prepared", intent.operationId, { projectId: intent.projectId });
      await validateIntent?.(executor, context, intent);
      return true;
    }),
    commit: (context: BoardImportHostContext, input: { intent: unknown }) => read(context, async executor => {
      const intent = validateBoardImportIntent(input.intent, context.companyId);
      await authorize(executor, context, intent.projectId);
      await validateIntent?.(executor, context, intent);
      await lock(executor, `board-import:operation:${context.companyId}:${intent.operationId}`);
      const retained = await operation(executor, context, intent.operationId);
      if (!retained || !isDeepStrictEqual(retained.intent, intent)) throw conflict("Exact prepared import intent required");
      if (retained.state === "committed") { await readReceiptInside(executor, context, intent.operationId); return; }
      await lock(executor, `board-import:source:${context.companyId}:${intent.task.sourceUrl.toLowerCase()}`);
      await lock(executor, `board-import:task:${context.companyId}:${intent.githubIssueNodeId}`);
      const { taskId, createdTask } = await createOrRecoverTask(executor, context, intent);
      const previous = await readState<BoardImportMembership>(executor, context.companyId, `membership:${intent.membershipKey}`);
      if (previous && (previous.taskId !== taskId || previous.githubIssueNodeId !== intent.githubIssueNodeId
        || previous.boardId !== intent.boardId || previous.boardItemId !== intent.boardItemId
        || previous.projectId !== intent.projectId || previous.companyId !== context.companyId)) {
        throw conflict("Board membership points at another task; existing record preserved");
      }
      if (previous && (Date.parse(previous.sourceUpdatedAt) > Date.parse(intent.sourceUpdatedAt)
        || (previous.sourceUpdatedAt === intent.sourceUpdatedAt && !isDeepStrictEqual(previous.fields, intent.fields)))) {
        throw conflict("A newer or ambiguous board membership snapshot is already retained; preserved");
      }
      const membership: BoardImportMembership = { key: intent.membershipKey, companyId: context.companyId,
        projectId: intent.projectId, boardId: intent.boardId, boardItemId: intent.boardItemId,
        githubIssueNodeId: intent.githubIssueNodeId, taskId, boardUrl: intent.boardUrl,
        sourceUpdatedAt: intent.sourceUpdatedAt, fields: intent.fields };
      await writeState(executor, context.companyId, `membership:${intent.membershipKey}`, membership);
      const task = await taskReadback(executor, context.companyId, intent.githubIssueNodeId);
      if (!task?.noDispatch) throw conflict("Active native import hold required before commit");
      const receipt: BoardImportReceipt = { operationId: intent.operationId, task, membership, createdTask };
      await writeState(executor, context.companyId, `operation:${intent.operationId}`, { ...retained, state: "committed", receipt });
      await audit(executor, context, "plugin.board_import.committed", taskId,
        { operationId: intent.operationId, projectId: intent.projectId, createdTask, boardId: intent.boardId, boardItemId: intent.boardItemId });
      // Recheck bounded observation freshness before commit; a failure rolls back every write.
      await validateIntent?.(executor, context, intent);
    }),
    readReceipt: (context: BoardImportHostContext, input: { operationId: string }) => read(context,
      executor => readReceiptInside(executor, context, validateBoardImportOperationId(input.operationId))),
    withStockCreationFence,
    getExcludedSources: (context: BoardImportHostContext) => transact(async executor => {
      await authorize(executor, context, undefined, true);
      const nativeRows = await executor.select().from(issues).where(and(
        eq(issues.companyId, context.companyId), eq(issues.originKind, origins.task),
      )).limit(MAX_EXCLUSIONS + 1);
      const journals = await executor.select().from(pluginState).where(and(
        eq(pluginState.pluginId, identity.pluginId), eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, context.companyId), eq(pluginState.namespace, BOARD_IMPORT_NAMESPACE),
        like(pluginState.stateKey, "task:%"),
      )).limit(MAX_EXCLUSIONS + 1);
      if (nativeRows.length > MAX_EXCLUSIONS || journals.length > MAX_EXCLUSIONS || nativeRows.length !== journals.length) {
        throw conflict("Incomplete native manual-import exclusion evidence; repository sync must remain held");
      }
      const sourceUrls: string[] = [];
      for (const row of nativeRows) {
        const existing = await taskJournal(executor, context.companyId, validateBoardImportNode(row.originId!));
        if (!existing || existing.issue.id !== row.id) throw conflict("Missing authoritative manual-import exclusion");
        sourceUrls.push(existing.journal.sourceUrl);
      }
      return { companyId: context.companyId, sourceUrls: [...new Set(sourceUrls)].sort() };
    }),
  };
}
