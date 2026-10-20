import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, companies, companyMemberships, companySecrets, createDb, heartbeatRuns, issues, issueTreeHolds, plugins,
  pluginState, projects, toolApplications, toolConnections } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createGitHubOAuthProviderConfig } from "@paperclipai/shared/github-oauth";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE, GITHUB_PROJECT_IMPORTER_KEY } from "../services/plugin-github-project-board.js";
import { githubProjectAuthorizationDigest } from "../services/github-oauth-project-page.js";
import { toolConnectionSnapshotColumns } from "../services/tool-connection-snapshot.js";
import { pluginGitHubProjectBoardService } from "../services/plugin-github-project-board.js";
import { pluginImportedIssuesService } from "../services/plugin-imported-issues.js";
import { GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS } from "../services/github-project-board-attestation.js";
import { boardImportDigest, type BoardImportIntent } from "../services/plugin-imported-issues-contract.js";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

// This fixture mocks the credential reader and exercises real native DB/state/RPC custody.
// The separate github-oauth-project-read fixture qualifies the actual reader; neither is execution proof until run.
const { pageReader } = vi.hoisted(() => ({ pageReader: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ readVerifiedGitHubProjectPage: pageReader }) }));
const capabilities = ["issues.read", "issues.create", "issues.update", "projects.read", "plugin.state.read", "plugin.state.write"] as const;
const boardUrl = "https://github.com/users/example/projects/12";
const pluginId = randomUUID(), peerId = randomUUID();
const dispose: Array<() => void> = [];
let db: ReturnType<typeof createDb>;
let fixture: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
function manifest(key: string): PaperclipPluginManifestV1 {
  return { id: key, apiVersion: 1, version: "0.0.0", displayName: "Synthetic OAuth bridge fixture",
    description: "Private native custody tests", author: "Fixture", categories: ["connector"],
    capabilities: [...capabilities], entrypoints: { worker: "./fixture.js" } };
}
function boardPage() {
  return { user: { projectV2: { id: "PVT_12", title: "Synthetic board", url: boardUrl,
    updatedAt: "2026-10-13T00:00:00Z", items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: "PVTI_1", isArchived: false, content: { __typename: "Issue", id: "I_1", number: 1,
        title: "Synthetic issue", url: "https://github.com/example/fixture/issues/1", state: "OPEN",
        repository: { nameWithOwner: "example/fixture" } },
      fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "ReadyForAgent", field: { name: "Status" } }] } }] } } } };
}
function handlers(id = pluginId, key = GITHUB_PROJECT_IMPORTER_KEY, caps: readonly string[] = capabilities) {
  const bus = { forPlugin: () => ({ subscribe: vi.fn(), emit: vi.fn(), clear: vi.fn() }),
    emit: vi.fn(), clearPlugin: vi.fn() } as unknown as PluginEventBus;
  const services = buildHostServices(db, id, key, bus, undefined, { manifest: manifest(key) });
  dispose.push(() => services.dispose());
  return createHostClientHandlers({ pluginId: id, capabilities: [...caps] as typeof capabilities[number][], services });
}
async function seed() {
  const companyId = randomUUID(), projectId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID(), secretId = randomUUID();
  const userId = `fixture-user-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Synthetic GitHub company",
    issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
  await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic existing destination", status: "planned" });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "admin" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "rest_api" });
  await db.insert(companySecrets).values({ id: secretId, companyId, key: "fixture-access", name: "Synthetic access metadata",
    latestVersion: 1, provider: "local_encrypted" }); // No value/version blob; this fixture's reader is mocked.
  const config = { sourceTemplateKey: "github", methodKey: "rest-oauth", serverUrl: "https://api.github.com",
    expectedGitHubLogin: "example", oauth: createGitHubOAuthProviderConfig("synthetic-client"),
    providerMetadata: { githubOAuth: { accountId: 42, login: "example", grantedScopes: ["repo", "project"],
      checkedAt: "2026-10-13T00:00:00Z" } } };
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Synthetic native GitHub",
    uid: connectionId, transport: "rest_api", authKind: "oauth", enabled: true, status: "active", config, transportConfig: config,
    credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest", required: true }] });
  const context = { invocationScope: { companyId, actor: { type: "user" as const, userId } } };
  const rpc = handlers();
  return { companyId, projectId, connectionId, secretId, userId, config, context, rpc,
    scope: { companyId, projectId }, bind: { companyId, projectId, connectionId, boardUrl } };
}
type Setup = Awaited<ReturnType<typeof seed>>;
async function binding(setup: Setup) {
  return setup.rpc["issues.importedBoard"]({ ...setup.bind, op: "bindProjectBoard" }, setup.context);
}
async function observe(setup: Setup) {
  return setup.rpc["issues.importedBoard"]({ ...setup.scope, op: "readProjectPage", page: {
    ownerType: "user", owner: "example", number: 12, first: 50, after: null,
  } }, setup.context);
}
function importIntent(setup: Setup, patch: Record<string, unknown> = {}): BoardImportIntent {
  const base = { ...setup.scope, boardId: "PVT_12", boardUrl, boardItemId: "PVTI_1", githubIssueNodeId: "I_1",
    sourceUpdatedAt: "2026-10-13T00:00:00Z", fields: [{ name: "Status", value: "ReadyForAgent" }],
    task: { ...setup.scope, githubIssueNodeId: "I_1", title: "Synthetic issue",
      sourceUrl: "https://github.com/example/fixture/issues/1", status: "backlog" as const,
      assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const }, ...patch };
  const data = { ...base, taskKey: boardImportDigest(["github-issue", base.companyId, base.githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", base.companyId, base.boardId, base.boardItemId]) };
  // Hash order intentionally matches the native canonical contract exactly.
  const ordered = { companyId: data.companyId, projectId: data.projectId, taskKey: data.taskKey, membershipKey: data.membershipKey,
    boardId: data.boardId, boardItemId: data.boardItemId, githubIssueNodeId: data.githubIssueNodeId, boardUrl: data.boardUrl,
    sourceUpdatedAt: data.sourceUpdatedAt, task: data.task, fields: data.fields };
  const intentHash = boardImportDigest(["board-import-v1", ordered]);
  return { ...ordered, operationId: intentHash, intentHash } as BoardImportIntent;
}
async function state(setup: Setup) {
  return db.select().from(pluginState).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, setup.companyId)));
}
async function noAgentEffects(setup: Setup) {
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, setup.companyId))).toEqual([]);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, setup.companyId))).toEqual([]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitForNativeLock(pid: number, finished: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const rows = await db.execute(sql`select wait_event_type from pg_stat_activity where pid = ${pid}`);
    if (rows[0]?.wait_event_type === "Lock") return;
    if (finished()) throw new Error("Protected authorization mutation completed before import transaction released its locks");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Native PostgreSQL lock custody was not observed within its bounded fixture deadline");
}
describe("native GitHub board OAuth binding/RPC custody", () => {
  beforeAll(async () => {
    fixture = await startBoardImportFixtureDatabase();
    // Synthetic lock proof needs import + competing mutation + independent pg_stat_activity observer.
    db = createDb(fixture.connectionString, { maxConnections: 4 });
    await db.insert(plugins).values([
      { id: pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY, packageName: "@fixture/github", version: "0.0.0", status: "ready",
        manifestJson: manifest(GITHUB_PROJECT_IMPORTER_KEY) },
      { id: peerId, pluginKey: "fixture.peer", packageName: "@fixture/peer", version: "0.0.0", status: "ready", manifestJson: manifest("fixture.peer") },
    ]);
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  beforeEach(() => {
    pageReader.mockReset().mockImplementation(async input => {
    const [connection] = await db.select(toolConnectionSnapshotColumns).from(toolConnections).where(eq(toolConnections.id, input.connectionId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, connection.credentialSecretRefs[0].secretId));
    return { page: boardPage(), account: { accountId: 42, login: "example" },
      authorizationDigest: githubProjectAuthorizationDigest(connection, { secretId: secret.id, latestVersion: secret.latestVersion }) };
    });
  });
  afterEach(() => dispose.splice(0).forEach(action => action()));
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await fixture?.cleanup(); } }, 30_000);
  it("lists metadata only, explicitly binds twice to one stable host record and imports twice without duplicates/wakes", async () => {
    const setup = await seed();
    const listed = await setup.rpc["issues.importedBoard"]({ ...setup.scope, op: "listProjectConnections" }, setup.context);
    expect(listed).toEqual({ ...setup.scope, connections: [{ connectionId: setup.connectionId, name: "Synthetic native GitHub",
      accountId: 42, login: "example", lastVerifiedAt: "2026-10-13T00:00:00Z" }] });
    expect(pageReader).not.toHaveBeenCalled();
    const first = await binding(setup); expect(await binding(setup)).toEqual(first);
    expect((await state(setup)).filter(row => row.stateKey === `project:${setup.projectId}`)).toHaveLength(1);
    await observe(setup); const intent = importIntent(setup);
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent }, setup.context)).toBe(true);
    await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "commit", intent }, setup.context);
    const receipt = await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readReceipt", operationId: intent.operationId }, setup.context);
    await observe(setup);
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent }, setup.context)).toBe(false);
    await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "commit", intent }, setup.context);
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readReceipt", operationId: intent.operationId }, setup.context)).toEqual(receipt);
    expect(await db.select().from(issues).where(eq(issues.companyId, setup.companyId))).toHaveLength(2); // one manual parent, one issue
    await noAgentEffects(setup);
  });
  it.each(["get", "set", "delete"] as const)("denies worker state.%s access to every reserved binding namespace form", async op => {
    const setup = await seed(); await binding(setup); const before = await state(setup);
    for (const namespace of [GITHUB_PROJECT_BINDING_NAMESPACE, ` ${GITHUB_PROJECT_BINDING_NAMESPACE} `]) {
      const args = { scopeKind: "company" as const, scopeId: setup.companyId, namespace, stateKey: `project:${setup.projectId}`, value: {} };
      await expect(setup.rpc[`state.${op}`](args, setup.context)).rejects.toThrow("host-owned");
    }
    expect(await state(setup)).toEqual(before);
  });
  it.each(["listProjectConnections", "readProjectBinding", "bindProjectBoard", "readProjectPage"] as const)
    ("refuses unknown %s fields, company/actor mismatch and missing projects.read before credentials/state writes", async op => {
      const setup = await seed();
      const request = { ...setup.scope, op, ...(op === "bindProjectBoard" ? setup.bind : {}),
        ...(op === "readProjectPage" ? { page: { ownerType: "user", owner: "example", number: 12, first: 50, after: null } } : {}) };
      await expect(setup.rpc["issues.importedBoard"]({ ...request, query: "mutation{}" } as never, setup.context)).rejects.toThrow();
      await expect(setup.rpc["issues.importedBoard"](request as never, { invocationScope: { companyId: randomUUID(), actor: setup.context.invocationScope.actor } })).rejects.toThrow();
      await expect(setup.rpc["issues.importedBoard"](request as never, { invocationScope: { companyId: setup.companyId, actor: { type: "agent" } } })).rejects.toThrow();
      await expect(handlers(pluginId, GITHUB_PROJECT_IMPORTER_KEY, capabilities.filter(cap => cap !== "projects.read"))["issues.importedBoard"](request as never, setup.context)).rejects.toThrow();
      expect(pageReader).not.toHaveBeenCalled(); expect(await state(setup)).toEqual([]); await noAgentEffects(setup);
    });
  it("refuses foreign projects, viewer members, PAT and cross-plugin native connection access before credentials", async () => {
    const setup = await seed(), foreign = await seed();
    await expect(setup.rpc["issues.importedBoard"]({ ...setup.bind, projectId: foreign.projectId, op: "bindProjectBoard" }, setup.context)).rejects.toThrow();
    await expect(handlers(peerId, "fixture.peer")["issues.importedBoard"]({ ...setup.bind, op: "bindProjectBoard" }, setup.context)).rejects.toThrow();
    await db.update(toolConnections).set({ authKind: "api_key" }).where(eq(toolConnections.id, setup.connectionId));
    await expect(binding(setup)).rejects.toThrow();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, setup.companyId));
    await expect(binding(setup)).rejects.toThrow();
    expect(pageReader).not.toHaveBeenCalled(); expect(await state(setup)).toEqual([]);
  });
  it("preserves a different retained connection and forbids account changes and wrong-board page reads", async () => {
    const setup = await seed(); const saved = await binding(setup); const before = await state(setup);
    await expect(setup.rpc["issues.importedBoard"]({ ...setup.bind, boardUrl: boardUrl.replace("/12", "/11"), op: "bindProjectBoard" }, setup.context)).rejects.toThrow();
    await expect(setup.rpc["issues.importedBoard"]({ ...setup.scope, op: "readProjectPage",
      page: { ownerType: "user", owner: "other", number: 12, first: 50, after: null } }, setup.context)).rejects.toThrow();
    expect(await state(setup)).toEqual(before);
    await db.update(toolConnections).set({ config: { ...setup.config, providerMetadata: { githubOAuth: {
      accountId: 43, login: "example", grantedScopes: ["repo", "project"] } } } }).where(eq(toolConnections.id, setup.connectionId));
    await expect(observe(setup)).rejects.toThrow("account changed");
    expect(await setup.rpc["issues.importedBoard"]({ ...setup.scope, op: "readProjectBinding" }, setup.context)).toEqual(saved);
  });
  it.each(["begin", "commit"] as const)("refuses %s without binding or fresh complete host attestation", async op => {
    const setup = await seed(); const intent = importIntent(setup);
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op, intent }, setup.context)).rejects.toThrow();
    await binding(setup);
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op, intent }, setup.context)).rejects.toThrow();
    await observe(setup);
    const before = await state(setup), forged = importIntent(setup, { task: { ...intent.task, title: "Forged valid-hash title" } });
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op, intent: forged }, setup.context)).rejects.toThrow("host-observed");
    expect(await state(setup)).toEqual(before);
    expect(await db.select().from(issues).where(eq(issues.companyId, setup.companyId))).toEqual([]);
    await noAgentEffects(setup);
  });
  it("invalidates old complete observations before a failed fresh page read; recovery never resolves credentials", async () => {
    const setup = await seed(); await binding(setup); await observe(setup);
    pageReader.mockRejectedValueOnce(new Error("synthetic read failure"));
    await expect(observe(setup)).rejects.toThrow();
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent: importIntent(setup) }, setup.context)).rejects.toThrow("fresh complete");
    pageReader.mockClear();
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readReceipt", operationId: importIntent(setup).operationId }, setup.context)).toBeNull();
    expect(pageReader).not.toHaveBeenCalled(); await noAgentEffects(setup);
  });
  it("refuses stale authorization revision and disabled parent application without task mutation", async () => {
    const setup = await seed(); await binding(setup); await observe(setup);
    await db.update(toolConnections).set({ config: { ...setup.config, label: "changed-without-timestamp" } })
      .where(eq(toolConnections.id, setup.connectionId));
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent: importIntent(setup) }, setup.context))
      .rejects.toThrow("fresh complete");
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, setup.connectionId));
    await db.update(toolApplications).set({ status: "archived" }).where(eq(toolApplications.id, connection.applicationId));
    pageReader.mockClear(); await expect(observe(setup)).rejects.toThrow();
    expect(pageReader).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.companyId, setup.companyId))).toEqual([]);
    await noAgentEffects(setup);
  });
  it("invalidates a completed observation after access-secret rotation without resolving a bearer", async () => {
    const setup = await seed(); await binding(setup); await observe(setup); pageReader.mockClear();
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, setup.secretId));
    await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent: importIntent(setup) }, setup.context))
      .rejects.toThrow("fresh complete");
    expect(pageReader).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.companyId, setup.companyId))).toEqual([]);
  });
  it.each(["connection", "secret", "application"] as const)
    ("holds actual %s row custody through the SAME native import transaction", async target => {
      const setup = await seed(); await binding(setup); await observe(setup);
      const intent = importIntent(setup), hostContext = { companyId: setup.companyId, actor: setup.context.invocationScope.actor };
      await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent }, setup.context);
      const bridge = pluginGitHubProjectBoardService(db, { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, pageReader);
      const entered = deferred<void>(), release = deferred<void>(), mutationEntered = deferred<number>();
      let held = false, changed = false;
      const importer = pluginImportedIssuesService(db, { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, async (executor, context, value) => {
        await bridge.assertImportBinding(context, value, executor);
        if (!held) { held = true; entered.resolve(); await release.promise; }
      });
      const commit = importer.commit(hostContext, { intent }).then(() => ({ error: null as unknown }), error => ({ error }));
      await Promise.race([entered.promise, commit.then(() => { throw new Error("Native import did not reach its held validator"); })]);
      const mutation = db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '10000ms'`);
        const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
        mutationEntered.resolve(Number(rows[0].pid));
        if (target === "connection") await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, setup.connectionId));
        if (target === "secret") await tx.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, setup.secretId));
        if (target === "application") {
          const [connection] = await tx.select().from(toolConnections).where(eq(toolConnections.id, setup.connectionId));
          await tx.update(toolApplications).set({ status: "disabled" }).where(eq(toolApplications.id, connection.applicationId));
        }
        changed = true;
      }).then(() => ({ error: null as unknown }), error => ({ error }));
      try {
        const pid = await Promise.race([mutationEntered.promise,
          mutation.then(() => { throw new Error("Authorization mutation did not reach its expected native session"); })]);
        await waitForNativeLock(pid, () => changed);
        expect(changed).toBe(false);
      } finally { release.resolve(); }
      expect((await commit).error).toBeNull(); expect((await mutation).error).toBeNull();
      expect(changed).toBe(true);
      const receipt = await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readReceipt", operationId: intent.operationId }, setup.context);
      expect(receipt).not.toBeNull();
      await expect(setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "commit", intent }, setup.context)).rejects.toThrow();
      await noAgentEffects(setup);
    });
  it("rolls back every write if observation expires after initial validation but before transaction completion", async () => {
    const setup = await seed(); await binding(setup); await observe(setup);
    const intent = importIntent(setup), hostContext = { companyId: setup.companyId, actor: setup.context.invocationScope.actor };
    await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "begin", intent }, setup.context);
    const before = await state(setup);
    const beforeActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, setup.companyId));
    const bridge = pluginGitHubProjectBoardService(db, { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, pageReader);
    let validationCount = 0, fixtureClock = Date.now();
    const importer = pluginImportedIssuesService(db, { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, async (executor, context, value) => {
      await bridge.assertImportBinding(context, value, executor);
      if (++validationCount === 1) fixtureClock += GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS + 1;
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => fixtureClock);
    try {
      await expect(importer.commit(hostContext, { intent })).rejects.toThrow("fresh complete");
    } finally { clock.mockRestore(); }
    expect(validationCount).toBe(1); // Completion revalidation refused before returning from its validator.
    expect(await state(setup)).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, setup.companyId))).toEqual(beforeActivity);
    expect(await db.select().from(issues).where(eq(issues.companyId, setup.companyId))).toEqual([]);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, setup.companyId))).toEqual([]);
    expect((await state(setup)).some(row => row.stateKey.startsWith("membership:"))).toBe(false);
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readReceipt", operationId: intent.operationId }, setup.context)).toBeNull();
    expect(await setup.rpc["issues.importedBoard"]({ companyId: setup.companyId, op: "readOperation", operationId: intent.operationId }, setup.context))
      .toMatchObject({ state: "prepared", operationId: intent.operationId });
    await noAgentEffects(setup);
  });
});
