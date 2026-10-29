import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRuns,
  issueTreeHolds, issues, pluginEntities, plugins, pluginState, projects,
} from "@paperclipai/db";
import {
  BOARD_IMPORT_NAMESPACE, BOARD_IMPORT_ROOT_TITLE, boardImportDigest, boardImportOrigins,
  validateBoardImportIntent, type BoardImportHostContext, type BoardImportIntent,
} from "../services/plugin-imported-issues-contract.js";
import { pluginImportedIssuesService } from "../services/plugin-imported-issues.js";
import { issueService } from "../services/issues.js";
import {
  BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase,
} from "./helpers/board-import-fixture-db.js";

function intent(companyId = randomUUID(), projectId = randomUUID(), overrides: Partial<BoardImportIntent> = {}): BoardImportIntent {
  const scope = { companyId, projectId };
  const githubIssueNodeId = overrides.githubIssueNodeId ?? "I_fixture_node_1";
  const task = { ...scope, githubIssueNodeId, title: "Import fixture", sourceUrl: "https://github.com/example/fixture/issues/1",
    status: "backlog" as const, assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const, ...overrides.task };
  const boardId = overrides.boardId ?? "PVT_fixture_board_12";
  const boardItemId = overrides.boardItemId ?? "PVTI_fixture_item_1";
  const data = { ...scope, taskKey: boardImportDigest(["github-issue", companyId, githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", companyId, boardId, boardItemId]),
    boardId, boardItemId, githubIssueNodeId, boardUrl: overrides.boardUrl ?? "https://github.com/users/example/projects/12",
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? "2026-10-12T19:00:00Z", task,
    fields: overrides.fields ?? [{ name: "Status", value: "Ready" }] };
  const intentHash = boardImportDigest(["board-import-v1", data]);
  return { ...data, intentHash, operationId: intentHash };
}

describe("bounded board import contract", () => {
  it("accepts the exact plugin digest and preserves board fields as reference metadata", () => {
    const input = intent();
    expect(validateBoardImportIntent(input, input.companyId)).toEqual(input);
  });
  it.each([
    (input: BoardImportIntent) => ({ ...input, taskKey: "f".repeat(64) }),
    (input: BoardImportIntent) => ({ ...input, intentHash: "f".repeat(64) }),
    (input: BoardImportIntent) => ({ ...input, task: { ...input.task, status: "todo" } }),
    (input: BoardImportIntent) => ({ ...input, task: { ...input.task, assigneeAgentId: randomUUID() } }),
    (input: BoardImportIntent) => ({ ...input, task: { ...input.task, noDispatch: false } }),
    (input: BoardImportIntent) => ({ ...input, task: { ...input.task, watchdog: { agentId: randomUUID() } } }),
    (input: BoardImportIntent) => ({ ...input, boardUrl: "https://github.com@evil.invalid/users/example/projects/12" }),
    (input: BoardImportIntent) => ({ ...input, githubIssueNodeId: "I_bad node" }),
  ])("rejects a broken policy, digest or hostile URL before persistence (%#)", mutate => {
    const input = intent();
    expect(() => validateBoardImportIntent(mutate(input), input.companyId)).toThrow();
  });
  it("rejects a company mismatch", () => {
    expect(() => validateBoardImportIntent(intent(), randomUUID())).toThrow();
  });
});

describe("native board import transaction and readback", () => {
  let db!: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
  beforeAll(async () => {
    fixture = await startBoardImportFixtureDatabase();
    db = createDb(fixture.connectionString);
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => { await fixture?.cleanup(); }, 25_000);

  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), pluginId = randomUUID();
    const pluginKey = `paperclip.fixture-${pluginId}`;
    const context: BoardImportHostContext = { companyId, actor: { type: "user", userId: `fixture-user-${companyId}` } };
    await db.insert(companies).values({ id: companyId, name: "Synthetic import company",
      issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic MemSys", status: "planned" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: context.actor.userId!,
      status: "active", membershipRole: "admin" });
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/fixture", version: "0.0.0",
      status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "0.0.0", displayName: "Synthetic fixture",
        description: "Disposable native import fixture", author: "Paperclip", categories: ["automation"],
        capabilities: [], entrypoints: { worker: "./worker.js" } } });
    const service = pluginImportedIssuesService(db, { pluginId, pluginKey });
    return { companyId, projectId, pluginId, pluginKey, context, service, input: intent(companyId, projectId) };
  }
  async function importItem(setup: Awaited<ReturnType<typeof seed>>, input = setup.input) {
    expect(await setup.service.begin(setup.context, { intent: input })).toBe(true);
    await setup.service.commit(setup.context, { intent: input });
    return (await setup.service.readReceipt(setup.context, { operationId: input.operationId }))!;
  }
  const nativeTasks = (companyId: string) => db.select().from(issues).where(eq(issues.companyId, companyId));
  const nativeState = (companyId: string) => db.select().from(pluginState).where(eq(pluginState.scopeId, companyId));

  it("imports twice without duplicate tasks, operation receipts, assignment or wake rows", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    expect(first.createdTask).toBe(true);
    expect(first.task.noDispatch).toBe(true);
    expect(await setup.service.begin(setup.context, { intent: setup.input })).toBe(false);
    await setup.service.commit(setup.context, { intent: setup.input });
    expect(await setup.service.readReceipt(setup.context, { operationId: setup.input.operationId })).toEqual(first);
    expect(await nativeTasks(setup.companyId)).toHaveLength(2); // Dedicated parent plus one imported task.
    expect((await nativeState(setup.companyId)).filter(row => row.stateKey.startsWith("membership:"))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, setup.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, setup.companyId))).toHaveLength(0);
    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, setup.companyId));
    expect(activities.map(row => row.action)).not.toContain("issue.created");
    expect(activities.map(row => row.action)).not.toContain("issue.updated");
    expect(first.task.assigneeAgentId).toBeNull();
    expect(first.task.assigneeUserId).toBeNull();
  });

  it("reuses one immutable GitHub issue across two board memberships and concurrent transactions", async () => {
    const setup = await seed();
    const second = intent(setup.companyId, setup.projectId, { boardId: "PVT_other_board", boardItemId: "PVTI_other_item",
      boardUrl: "https://github.com/users/example/projects/13" });
    await Promise.all([setup.service.begin(setup.context, { intent: setup.input }), setup.service.begin(setup.context, { intent: second })]);
    await Promise.all([setup.service.commit(setup.context, { intent: setup.input }), setup.service.commit(setup.context, { intent: second })]);
    const a = (await setup.service.readReceipt(setup.context, { operationId: setup.input.operationId }))!;
    const b = (await setup.service.readReceipt(setup.context, { operationId: second.operationId }))!;
    expect(a.task.id).toBe(b.task.id);
    expect([a.createdTask, b.createdTask].sort()).toEqual([false, true]);
    expect(await nativeTasks(setup.companyId)).toHaveLength(2);
    expect((await nativeState(setup.companyId)).filter(row => row.stateKey.startsWith("membership:"))).toHaveLength(2);
  });

  it("rolls back task, hold, memberships and audit together if the encompassing transaction fails", async () => {
    const setup = await seed();
    await setup.service.begin(setup.context, { intent: setup.input });
    await expect(db.transaction(async tx => {
      await pluginImportedIssuesService(tx as unknown as typeof db, setup).commit(setup.context, { intent: setup.input });
      throw new Error("Synthetic crash before outer commit");
    })).rejects.toThrow("Synthetic crash");
    expect(await nativeTasks(setup.companyId)).toHaveLength(0);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, setup.companyId))).toHaveLength(0);
    expect((await nativeState(setup.companyId)).map(row => row.stateKey)).toEqual([`operation:${setup.input.operationId}`]);
    expect((await setup.service.readOperation(setup.context, { operationId: setup.input.operationId }))?.state).toBe("prepared");
  });

  it("derives noDispatch from the current native hold, not a saved or requested true value", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.companyId, setup.companyId));
    expect((await setup.service.readTask(setup.context, { githubIssueNodeId: setup.input.githubIssueNodeId }))?.noDispatch).toBe(false);
    expect((await setup.service.readReceipt(setup.context, { operationId: setup.input.operationId }))?.task.noDispatch).toBe(false);
    const next = intent(setup.companyId, setup.projectId, { boardId: "PVT_next", boardItemId: "PVTI_next" });
    await setup.service.begin(setup.context, { intent: next });
    await expect(setup.service.commit(setup.context, { intent: next })).rejects.toThrow();
    expect(await setup.service.getExcludedSources({ companyId: setup.companyId, actor: { type: "system" } }))
      .toEqual({ companyId: setup.companyId, sourceUrls: [first.task.sourceUrl] });
  });

  it("does not overwrite human task edits", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    await db.update(issues).set({ title: "Human changed this" }).where(eq(issues.id, first.task.id));
    await expect(setup.service.readTask(setup.context, { githubIssueNodeId: setup.input.githubIssueNodeId })).rejects.toThrow();
    const next = intent(setup.companyId, setup.projectId, { boardItemId: "PVTI_next" });
    await setup.service.begin(setup.context, { intent: next });
    await expect(setup.service.commit(setup.context, { intent: next })).rejects.toThrow();
    expect((await nativeTasks(setup.companyId)).find(row => row.id === first.task.id)?.title).toBe("Human changed this");
  });

  it("updates a changed upstream title only while the native task still matches its previous baseline", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    const next = intent(setup.companyId, setup.projectId, { sourceUpdatedAt: "2026-10-12T19:01:00Z",
      task: { ...setup.input.task, title: "Updated upstream title" } });
    const updated = await importItem(setup, next);
    expect(updated.task.id).toBe(first.task.id);
    expect(updated.createdTask).toBe(false);
    expect(updated.task.title).toBe("Updated upstream title");
    expect(updated.task.noDispatch).toBe(true);
    const saved = await setup.service.readOperation(setup.context, { operationId: next.operationId });
    expect(saved?.projectId).toBe(setup.projectId);
    expect(saved?.intent).toEqual(next);
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, setup.companyId)))
      .some(row => row.action === "issue.updated")).toBe(false);
  });

  it("rejects unauthorized actors, foreign destinations and another user's operation", async () => {
    const setup = await seed(), foreign = await seed();
    await expect(setup.service.begin({ companyId: setup.companyId, actor: { type: "agent" } }, { intent: setup.input })).rejects.toThrow();
    const crossProject = intent(setup.companyId, foreign.projectId);
    await expect(setup.service.begin(setup.context, { intent: crossProject })).rejects.toThrow();
    await setup.service.begin(setup.context, { intent: setup.input });
    const otherUser: BoardImportHostContext = { companyId: setup.companyId, actor: { type: "user", userId: "another-fixture-user" } };
    await db.insert(companyMemberships).values({ companyId: setup.companyId, principalType: "user", principalId: otherUser.actor.userId!, status: "active" });
    await expect(setup.service.readOperation(otherUser, { operationId: setup.input.operationId })).rejects.toThrow();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
      eq(companyMemberships.companyId, setup.companyId), eq(companyMemberships.principalId, setup.context.actor.userId!),
    ));
    await expect(setup.service.commit(setup.context, { intent: setup.input })).rejects.toThrow();
    expect(await nativeTasks(setup.companyId)).toHaveLength(0);
  });

  it("holds stock sync when a native manual origin survives journal loss or drift", async () => {
    const setup = await seed();
    await importItem(setup);
    await db.delete(pluginState).where(and(eq(pluginState.scopeId, setup.companyId),
      eq(pluginState.namespace, BOARD_IMPORT_NAMESPACE), eq(pluginState.stateKey, `task:${setup.input.taskKey}`)));
    await expect(setup.service.getExcludedSources({ companyId: setup.companyId, actor: { type: "system" } })).rejects.toThrow();
    await expect(setup.service.readTask(setup.context, { githubIssueNodeId: setup.input.githubIssueNodeId })).rejects.toThrow();
  });

  it("rejects legacy native or entity URL mappings before minting another task", async () => {
    for (const mode of ["native", "entity"] as const) {
      const setup = await seed();
      if (mode === "native") await db.insert(issues).values({ companyId: setup.companyId, projectId: setup.projectId,
        title: "Legacy task", originKind: `plugin:${setup.pluginKey}:github-issue`, originId: setup.input.task.sourceUrl });
      else await db.insert(pluginEntities).values({ pluginId: setup.pluginId, companyId: setup.companyId,
        entityType: "github_issue_link", scopeKind: "company", scopeId: setup.companyId, externalId: "legacy-123",
        data: { githubIssueId: 123, githubIssueUrl: setup.input.task.sourceUrl } });
      await setup.service.begin(setup.context, { intent: setup.input });
      await expect(setup.service.commit(setup.context, { intent: setup.input })).rejects.toThrow("repository-sync mapping");
      expect((await nativeTasks(setup.companyId)).some(row => row.title === BOARD_IMPORT_ROOT_TITLE)).toBe(false);
    }
  });

  it("refuses to redirect the same board item to another GitHub task", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    const next = intent(setup.companyId, setup.projectId, { githubIssueNodeId: "I_other_issue",
      task: { ...setup.input.task, githubIssueNodeId: "I_other_issue", sourceUrl: "https://github.com/example/fixture/issues/2" } });
    await setup.service.begin(setup.context, { intent: next });
    await expect(setup.service.commit(setup.context, { intent: next })).rejects.toThrow("another task");
    expect(await nativeTasks(setup.companyId)).toHaveLength(2);
    expect((await setup.service.readReceipt(setup.context, { operationId: setup.input.operationId }))?.task.id).toBe(first.task.id);
  });

  it("keeps task identity independent of titles and seven-day request-key retention", async () => {
    const setup = await seed();
    const first = await importItem(setup);
    await db.update(pluginState).set({ updatedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(pluginState.scopeId, setup.companyId));
    const repeat = intent(setup.companyId, setup.projectId, { boardItemId: "PVTI_later" });
    expect((await importItem(setup, repeat)).task.id).toBe(first.task.id);
    const different = intent(setup.companyId, setup.projectId, { githubIssueNodeId: "I_same_title_other",
      boardItemId: "PVTI_other_title", task: { ...setup.input.task, githubIssueNodeId: "I_same_title_other",
        sourceUrl: "https://github.com/example/fixture/issues/2" } });
    expect((await importItem(setup, different)).task.id).not.toBe(first.task.id);
    expect(await nativeTasks(setup.companyId)).toHaveLength(3);
    expect(boardImportOrigins(setup.pluginKey).task).toContain("github-board-manual");
  });

  it("fences stock creation after manual import, including path-case variants", async () => {
    const setup = await seed();
    await importItem(setup);
    let called = false;
    await expect(setup.service.withStockCreationFence(setup.companyId,
      "https://github.com/Example/Fixture/issues/1", async () => { called = true; }))
      .rejects.toMatchObject({ status: 409, details: { code: "manual_board_import_excluded" } });
    expect(called).toBe(false);
    expect(await nativeTasks(setup.companyId)).toHaveLength(2);
  });

  it("serializes concurrent stock creation versus manual import without duplicate GitHub tasks", async () => {
    const setup = await seed();
    await setup.service.begin(setup.context, { intent: setup.input });
    const outcomes = await Promise.allSettled([
      setup.service.commit(setup.context, { intent: setup.input }),
      setup.service.withStockCreationFence(setup.companyId, setup.input.task.sourceUrl, executor =>
        issueService(executor).create(setup.companyId, { title: "Stock fixture", status: "backlog",
          projectId: setup.projectId, originKind: `plugin:${setup.pluginKey}:github-issue`,
          originId: setup.input.task.sourceUrl, allowDuplicate: true })),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const rows = await nativeTasks(setup.companyId);
    expect(rows.filter(row => row.originKind !== boardImportOrigins(setup.pluginKey).root)).toHaveLength(1);
  });
});
