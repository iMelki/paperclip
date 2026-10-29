import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRuns,
  issueTreeHolds, issues, pluginState, plugins, projects, toolApplications, toolConnections, companySecrets,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createGitHubOAuthProviderConfig } from "@paperclipai/shared/github-oauth";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import type { WorkerHostCallContext } from "../../../packages/plugins/sdk/src/protocol.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  BOARD_IMPORT_NAMESPACE, boardImportDigest, boardImportOrigins,
  type BoardImportIntent, type BoardImportReceipt,
} from "../services/plugin-imported-issues-contract.js";
import { GITHUB_PROJECT_IMPORTER_KEY,
  pluginGitHubProjectBoardService } from "../services/plugin-github-project-board.js";
import { githubProjectAuthorizationDigest } from "../services/github-oauth-project-page.js";
import { toolConnectionSnapshotColumns } from "../services/tool-connection-snapshot.js";
import {
  BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase,
} from "./helpers/board-import-fixture-db.js";

const CAPABILITIES = ["issues.read", "issues.create", "issues.update", "projects.read",
  "plugin.state.read", "plugin.state.write"] as const;
const IMPORTER_ID = randomUUID();
type Handlers = ReturnType<typeof createHostClientHandlers>;
type UpdateRequest = Parameters<Handlers["issues.update"]>[0];
type CreateRequest = Parameters<Handlers["issues.create"]>[0];
const teardown: Array<() => void> = [];
let db: ReturnType<typeof createDb>;
let fixture: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;

function manifest(pluginKey: string): PaperclipPluginManifestV1 {
  return { id: pluginKey, apiVersion: 1, version: "0.0.0", displayName: "Synthetic boundary fixture",
    description: "Private disposable host boundary tests", author: "Fixture", categories: ["connector"],
    capabilities: [...CAPABILITIES], entrypoints: { worker: "./fixture-worker.js" } };
}
function importIntent(companyId: string, projectId: string): BoardImportIntent {
  const githubIssueNodeId = "I_fixture_boundary_1", boardId = "PVT_fixture_boundary_12";
  const boardItemId = "PVTI_fixture_boundary_1";
  const task = { companyId, projectId, githubIssueNodeId, title: "Synthetic protected issue",
    sourceUrl: "https://github.com/example/fixture/issues/1", status: "backlog" as const,
    assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const };
  const data = { companyId, projectId, taskKey: boardImportDigest(["github-issue", companyId, githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", companyId, boardId, boardItemId]),
    boardId, boardItemId, githubIssueNodeId, boardUrl: "https://github.com/users/example/projects/12",
    sourceUpdatedAt: "2026-10-12T00:00:00Z", task, fields: [{ name: "Status", value: "Ready" }] };
  const intentHash = boardImportDigest(["board-import-v1", data]);
  return { ...data, operationId: intentHash, intentHash };
}
function eventBusStub() {
  const emit = vi.fn(async () => ({ delivered: 0, errors: [] }));
  const clear = vi.fn();
  const bus = { emit, clearPlugin: clear, subscriptionCount: () => 0,
    forPlugin: () => ({ emit, subscribe: vi.fn(), clear }) } as unknown as PluginEventBus;
  return { bus, emit };
}
function handlersFor(pluginId: string, pluginKey: string, bus: PluginEventBus) {
  const services = buildHostServices(db, pluginId, pluginKey, bus, undefined, { manifest: manifest(pluginKey) });
  teardown.push(() => services.dispose());
  return createHostClientHandlers({ pluginId, capabilities: [...CAPABILITIES], services });
}
async function snapshot(companyId: string) {
  const [tasks, holds, journal, activity, wakes, runs] = await Promise.all([
    db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(asc(issues.id)),
    db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, companyId)).orderBy(asc(issueTreeHolds.id)),
    db.select().from(pluginState).where(eq(pluginState.scopeId, companyId)).orderBy(asc(pluginState.id)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(asc(activityLog.id)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
  ]);
  return { tasks, holds, journal, activity, wakes, runs };
}
async function protectedJournal(companyId: string, pluginId: string) {
  return db.select().from(pluginState).where(and(eq(pluginState.scopeId, companyId),
    eq(pluginState.pluginId, pluginId), eq(pluginState.namespace, BOARD_IMPORT_NAMESPACE))).orderBy(asc(pluginState.id));
}
async function seedNativeBoardAuthority(intent: BoardImportIntent, userId: string) {
  const applicationId = randomUUID(), connectionId = randomUUID(), secretId = randomUUID();
  await db.insert(toolApplications).values({ id: applicationId, companyId: intent.companyId,
    name: "Synthetic boundary GitHub", type: "rest_api" });
  // Metadata-only synthetic authority; this fixture neither decrypts nor contacts a provider.
  await db.insert(companySecrets).values({ id: secretId, companyId: intent.companyId, key: "fixture-access",
    name: "Synthetic boundary access metadata", provider: "local_encrypted", latestVersion: 1, status: "active" });
  const config = { sourceTemplateKey: "github", methodKey: "rest-oauth", serverUrl: "https://api.github.com",
    expectedGitHubLogin: "example", oauth: createGitHubOAuthProviderConfig("synthetic-boundary-client"),
    providerMetadata: { githubOAuth: { accountId: 42, login: "example", grantedScopes: ["repo", "project"],
      checkedAt: "2026-10-13T00:00:00Z" } } };
  const [connection] = await db.insert(toolConnections).values({ id: connectionId, companyId: intent.companyId,
    applicationId, uid: connectionId, name: "Synthetic boundary OAuth", transport: "rest_api", authKind: "oauth",
    enabled: true, status: "active", config, transportConfig: config,
    credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest", required: true }],
  }).returning(toolConnectionSnapshotColumns);
  const authorization = githubProjectAuthorizationDigest(connection, { secretId, latestVersion: 1 });
  const data = { user: { projectV2: { id: intent.boardId, title: "Synthetic boundary board", url: intent.boardUrl,
    updatedAt: intent.sourceUpdatedAt, items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: intent.boardItemId, isArchived: false, content: { __typename: "Issue", id: intent.githubIssueNodeId,
        number: 1, title: intent.task.title, url: intent.task.sourceUrl, state: "OPEN",
        repository: { nameWithOwner: "example/fixture" } },
      fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "Ready", field: { name: "Status" } }] } }] } } } };
  const nativeBoard = pluginGitHubProjectBoardService(db,
    { pluginId: IMPORTER_ID, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, async () => ({
      page: data, account: { accountId: 42, login: "example" }, authorizationDigest: authorization,
    }));
  const context = { companyId: intent.companyId, actor: { type: "user" as const, userId } };
  await nativeBoard.bind(context, { companyId: intent.companyId, projectId: intent.projectId,
    boardUrl: intent.boardUrl, connectionId });
  await nativeBoard.readProjectPage(context, { companyId: intent.companyId, projectId: intent.projectId,
    page: { ownerType: "user", owner: "example", number: 12, after: null, first: 50 } });
}
async function seed() {
  const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), outsideParentId = randomUUID();
  const importerId = IMPORTER_ID, peerId = randomUUID();
  const importerKey = GITHUB_PROJECT_IMPORTER_KEY, peerKey = `fixture.peer-${peerId}`;
  const userId = `fixture-operator-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Synthetic boundary company",
    issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
  await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic protected project", status: "planned" });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "admin" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic executor", status: "idle" });
  await db.insert(issues).values({ id: outsideParentId, companyId, projectId, title: "Unrelated fixture parent", status: "backlog" });
  await db.insert(plugins).values([
    { id: importerId, pluginKey: importerKey, packageName: "@fixture/importer", version: "0.0.0",
      status: "ready", manifestJson: manifest(importerKey) },
    { id: peerId, pluginKey: peerKey, packageName: "@fixture/peer", version: "0.0.0",
      status: "ready", manifestJson: manifest(peerKey) },
  ]).onConflictDoNothing();
  const events: unknown[] = [];
  teardown.push(subscribeCompanyLiveEvents(companyId, event => events.push(event)));
  const eventBus = eventBusStub();
  const importer = handlersFor(importerId, importerKey, eventBus.bus);
  const peer = handlersFor(peerId, peerKey, eventBus.bus);
  const context: WorkerHostCallContext = { invocationScope: { companyId, actor: { type: "user", userId } } };
  const intent = importIntent(companyId, projectId);
  await seedNativeBoardAuthority(intent, userId);
  expect(await importer["issues.importedBoard"]({ companyId, op: "begin", intent }, context)).toBe(true);
  await importer["issues.importedBoard"]({ companyId, op: "commit", intent }, context);
  const receipt = await importer["issues.importedBoard"]({ companyId, op: "readReceipt",
    operationId: intent.operationId }, context) as BoardImportReceipt;
  expect(receipt?.task.noDispatch).toBe(true);
  return { companyId, projectId, agentId, outsideParentId, importerId, importerKey, peerKey,
    importer, peer, context, intent, receipt, events, emit: eventBus.emit };
}
type Setup = Awaited<ReturnType<typeof seed>>;
async function expectUnchanged(setup: Setup, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(await snapshot(setup.companyId)).toEqual(before);
  expect(setup.events).toEqual([]);
  expect(setup.emit).not.toHaveBeenCalled();
  expect(before.wakes).toHaveLength(0);
  expect(before.runs).toHaveLength(0);
}

describe("native imported-board generic host boundary", () => {
  beforeAll(async () => {
    fixture = await startBoardImportFixtureDatabase();
    db = createDb(fixture.connectionString);
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterEach(() => {
    for (const dispose of teardown.splice(0).reverse()) dispose();
  });
  afterAll(async () => {
    try { await db?.$client.end({ timeout: 5 }); } finally { await fixture?.cleanup(); }
  }, 30_000);

  const patches: Array<{ name: string; patch: (setup: Setup) => UpdateRequest["patch"] }> = [
    { name: "reparent", patch: setup => ({ parentId: setup.outsideParentId }) },
    { name: "assign", patch: setup => ({ assigneeAgentId: setup.agentId, status: "todo" }) },
    { name: "change origin", patch: setup => ({ originKind: `plugin:${setup.peerKey}` }) },
    { name: "activate status", patch: () => ({ status: "todo" }) },
  ];
  for (const target of ["task", "root"] as const) {
    it.each(patches)(`blocks a second plugin from ${target}: $name`, async ({ patch }) => {
      const setup = await seed();
      const root = await db.select().from(issues).where(and(eq(issues.companyId, setup.companyId),
        eq(issues.originKind, boardImportOrigins(setup.importerKey).root))).then(rows => rows[0]);
      if (!root) throw new Error("Native import fixture parent was not created");
      const before = await snapshot(setup.companyId);
      await expect(setup.peer["issues.update"]({ companyId: setup.companyId,
        issueId: target === "task" ? setup.receipt.task.id : root.id, patch: patch(setup) }, setup.context))
        .rejects.toThrow("protected board-import task");
      await expectUnchanged(setup, before);
    });
  }

  it("preserves protected work without blocking an unrelated same-company task update", async () => {
    const setup = await seed();
    const before = await snapshot(setup.companyId);
    await setup.peer["issues.update"]({ companyId: setup.companyId, issueId: setup.outsideParentId,
      patch: { title: "Unrelated fixture update", actorUserId: setup.context.invocationScope!.actor!.userId } }, setup.context);
    const after = await snapshot(setup.companyId);
    expect(after.tasks.filter(row => row.id !== setup.outsideParentId))
      .toEqual(before.tasks.filter(row => row.id !== setup.outsideParentId));
    expect(after.holds).toEqual(before.holds);
    expect(after.journal).toEqual(before.journal);
    expect(after.tasks.find(row => row.id === setup.outsideParentId)?.title).toBe("Unrelated fixture update");
    expect(setup.events.length).toBeGreaterThan(0);
    expect(after.wakes).toHaveLength(0);
    expect(after.runs).toHaveLength(0);
  });

  it.each(["get", "set", "delete"] as const)("denies exact native journal namespace through state.%s", async method => {
    const setup = await seed();
    const before = await snapshot(setup.companyId);
    const input = { scopeKind: "company" as const, scopeId: setup.companyId,
      namespace: BOARD_IMPORT_NAMESPACE, stateKey: `task:${setup.intent.taskKey}` };
    const request = method === "set" ? { ...input, value: { attemptedOverwrite: true } } : input;
    await expect(setup.importer[`state.${method}`](request as never, setup.context))
      .rejects.toThrow("Native board import journal and OAuth binding are host-owned");
    await expectUnchanged(setup, before);
  });

  it("denies padded journal names while case/default namespaces cannot affect the native journal", async () => {
    const setup = await seed();
    const before = await snapshot(setup.companyId);
    const journal = await protectedJournal(setup.companyId, setup.importerId);
    for (const namespace of [BOARD_IMPORT_NAMESPACE + " ", " " + BOARD_IMPORT_NAMESPACE]) {
      const input = { scopeKind: "company" as const, scopeId: setup.companyId, namespace,
        stateKey: `task:${setup.intent.taskKey}` };
      for (const method of ["get", "set", "delete"] as const) {
        const request = method === "set" ? { ...input, value: { attemptedOverwrite: true } } : input;
        await expect(setup.importer[`state.${method}`](request as never, setup.context))
          .rejects.toThrow("Native board import journal and OAuth binding are host-owned");
        await expectUnchanged(setup, before);
      }
    }
    for (const namespace of [BOARD_IMPORT_NAMESPACE.toUpperCase(), "default"]) {
      const input = { scopeKind: "company" as const, scopeId: setup.companyId, namespace,
        stateKey: `task:${setup.intent.taskKey}` };
      expect(await setup.importer["state.get"](input, setup.context)).toBeNull();
      const value = { distinctNamespaceFixture: true };
      await setup.importer["state.set"]({ ...input, value }, setup.context);
      expect(await setup.importer["state.get"](input, setup.context)).toEqual(value);
      expect(await protectedJournal(setup.companyId, setup.importerId)).toEqual(journal);
      await setup.importer["state.delete"](input, setup.context);
      expect(await setup.importer["state.get"](input, setup.context)).toBeNull();
      expect(await protectedJournal(setup.companyId, setup.importerId)).toEqual(journal);
    }
    await expectUnchanged(setup, before);
  });

  it.each([undefined, null, 12, "", "https://github.com.evil.invalid/example/fixture/issues/1",
    "https://github.com/example/fixture/issues/1?token=synthetic", "https://github.com/example/fixture/issues/0"])
  ("denies malformed generic stock GitHub identity before creation (%#)", async originId => {
    const setup = await seed();
    const before = await snapshot(setup.companyId);
    const request = { companyId: setup.companyId, projectId: setup.projectId, title: "Must not be created",
      originKind: `plugin:${setup.peerKey}:github-issue`, originId } as unknown as CreateRequest;
    await expect(setup.peer["issues.create"](request, setup.context)).rejects.toThrow(/canonical|source|GitHub/);
    await expectUnchanged(setup, before);
  });

  it("the actual generic SDK create caller excludes another plugin's protected source URL", async () => {
    const setup = await seed();
    const before = await snapshot(setup.companyId);
    await expect(setup.peer["issues.create"]({ companyId: setup.companyId, projectId: setup.projectId,
      title: "Must not duplicate a manual import", originKind: `plugin:${setup.peerKey}:github-issue`,
      originId: "https://github.com/Example/Fixture/issues/1" }, setup.context))
      .rejects.toMatchObject({ status: 409, details: { code: "manual_board_import_excluded" } });
    await expectUnchanged(setup, before);
  });
});
