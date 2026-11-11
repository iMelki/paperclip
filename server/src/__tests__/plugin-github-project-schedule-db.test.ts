import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySecrets, createDb, plugins, pluginJobRuns, pluginJobs,
  projects, toolApplications, toolConnections } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createGitHubOAuthProviderConfig } from "@paperclipai/shared/github-oauth";
import { errorHandler } from "../middleware/index.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE, GITHUB_PROJECT_IMPORTER_KEY,
  pluginGitHubProjectBoardService } from "../services/plugin-github-project-board.js";
import { pluginGitHubProjectScheduleGrants } from "../services/plugin-github-project-schedule-grants.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY, GITHUB_PROJECT_GRANT_MAX_AGE_MS,
  type GitHubProjectScheduleGrant } from "../services/github-project-schedule-grant-contract.js";
import { createScheduledGitHubProjectBoardService } from "../services/plugin-github-project-scheduled.js";
import { createGitHubProjectBoardSchedulerBridge } from "../services/plugin-github-project-board-scheduler-bridge.js";
import { createPluginJobEnvelope } from "../services/plugin-job-scope.js";
import { registerGitHubProjectScheduleGrantRoutes } from "../routes/plugin-github-project-schedule-grants.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { githubProjectAuthorizationDigest } from "../services/github-oauth-project-page.js";
import { toolConnectionSnapshotColumns } from "../services/tool-connection-snapshot.js";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

// Real (isolated fixture) PostgreSQL: grant persistence, the scheduled-run target filter and the scheduled-run lease.
// Only the GitHub page reader is synthetic. The fixture never touches a live instance database.
const boardUrl = "https://github.com/users/example/projects/12";
const pluginId = randomUUID();
const identity = { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY };
const HOUR = 3_600_000;
let db: ReturnType<typeof createDb>;
let fixture: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
let jobId: string;

function manifest(): PaperclipPluginManifestV1 {
  return { id: GITHUB_PROJECT_IMPORTER_KEY, apiVersion: 1, version: "0.0.0", displayName: "Synthetic schedule fixture",
    description: "Private native schedule tests", author: "Fixture", categories: ["connector"],
    capabilities: ["issues.read", "issues.create", "issues.update", "projects.read", "plugin.state.read", "plugin.state.write"],
    entrypoints: { worker: "./fixture.js" } };
}
function boardPage(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `PVTI_${index + 1}`, isArchived: false,
    content: { __typename: "Issue", id: `I_${index + 1}`, number: index + 1, title: `Synthetic issue ${index + 1}`,
      url: `https://github.com/example/fixture/issues/${index + 1}`, state: "OPEN", repository: { nameWithOwner: "example/fixture" } },
    fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: "ReadyForAgent", field: { name: "Status" } }] } }));
  return { user: { projectV2: { id: "PVT_12", title: "Synthetic board", url: boardUrl, updatedAt: "2026-10-13T00:00:00Z",
    items: { totalCount: count, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
}

async function seed() {
  const companyId = randomUUID(), projectId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID(), secretId = randomUUID();
  const userId = `fixture-user-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Synthetic GitHub company",
    issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
  await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic destination", status: "planned" });
  await db.insert(agents).values({ id: randomUUID(), companyId, name: "Synthetic executor", status: "idle" });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "rest_api" });
  await db.insert(companySecrets).values({ id: secretId, companyId, key: "fixture-access", name: "Synthetic access metadata",
    latestVersion: 1, provider: "local_encrypted" });
  const config = { sourceTemplateKey: "github", methodKey: "rest-oauth", serverUrl: "https://api.github.com",
    expectedGitHubLogin: "example", oauth: createGitHubOAuthProviderConfig("synthetic-client"),
    providerMetadata: { githubOAuth: { accountId: 42, login: "example", grantedScopes: ["repo", "project"], checkedAt: "2026-10-13T00:00:00Z" } } };
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Synthetic native GitHub", uid: connectionId,
    transport: "rest_api", authKind: "oauth", enabled: true, status: "active", config, transportConfig: config,
    credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest", required: true }] });
  const context = { companyId, actor: { type: "user" as const, userId } } as never;
  const boards = pluginGitHubProjectBoardService(db, identity, async input => {
    const [connection] = await db.select(toolConnectionSnapshotColumns).from(toolConnections).where(eq(toolConnections.id, input.connectionId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, connection.credentialSecretRefs[0].secretId));
    return { page: boardPage(1), account: { accountId: 42, login: "example" },
      authorizationDigest: githubProjectAuthorizationDigest(connection, { secretId: secret.id, latestVersion: secret.latestVersion }) };
  });
  await boards.bind(context, { companyId, projectId, connectionId, boardUrl });
  return { companyId, projectId, connectionId, userId, context, scope: { companyId, projectId }, boards,
    grants: pluginGitHubProjectScheduleGrants(db, identity, boards) };
}
type Setup = Awaited<ReturnType<typeof seed>>;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const createGrant = (setup: Setup, overrides: Record<string, unknown> = {}) => setup.grants.create(setup.context,
  { ...setup.scope, expectedRevision: 0, jobId, enabled: true, maxItems: 5, expiresAt: inHours(1), ...overrides });
async function addBoundProject(setup: Setup) {
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, companyId: setup.companyId, name: "Synthetic second destination", status: "planned" });
  await setup.boards.bind(setup.context, { companyId: setup.companyId, projectId, connectionId: setup.connectionId, boardUrl });
  return { companyId: setup.companyId, projectId };
}
async function runRow(companyId: string) {
  const [row] = await db.insert(pluginJobRuns).values({ jobId, pluginId, companyId, trigger: "schedule", status: "running",
    startedAt: new Date() }).returning({ id: pluginJobRuns.id });
  return row!.id;
}
const store = () => pluginStateStore(db);
const stateOptions = (companyId: string) => ({ scopeId: companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
async function retainedGrant(setup: Setup) {
  return await store().get(pluginId, "company", `schedule-grant:${setup.projectId}`, stateOptions(setup.companyId)) as GitHubProjectScheduleGrant;
}
async function logs(runId: string) {
  const [row] = await db.select({ logs: pluginJobRuns.logs }).from(pluginJobRuns).where(eq(pluginJobRuns.id, runId));
  return (row?.logs ?? []).map(entry => JSON.parse(String(entry)) as Record<string, unknown>);
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
const custody = (epoch = "epoch-one") => ({ ownerEpoch: epoch, isCurrent: () => true });
const targetFor = (setup: Setup, jobRunId: string) => ({ pluginId, companyId: setup.companyId, projectId: setup.projectId, jobId, jobRunId });
function scheduledService(count: number, gate?: Promise<void>) {
  const reader = vi.fn(async (input: { authorizationDigest: string }) => {
    await gate;
    return { page: boardPage(count), account: { accountId: 42, login: "example" }, authorizationDigest: input.authorizationDigest };
  });
  return { reader, service: createScheduledGitHubProjectBoardService(db, identity, reader as never, { enabled: true }) };
}

const WINDOWS_NATIVE_FIXTURE_MISSING = process.platform === "win32" && !process.env.PAPERCLIP_BOARD_FIXTURE_ROOT;
describe.skipIf(WINDOWS_NATIVE_FIXTURE_MISSING)("native board schedule grants, target filter and lease (isolated PostgreSQL)", () => {
  beforeAll(async () => {
    fixture = await startBoardImportFixtureDatabase();
    db = createDb(fixture.connectionString, { maxConnections: 6 });
    await db.insert(plugins).values({ id: pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY, packageName: "@fixture/github", version: "0.0.0",
      status: "ready", manifestJson: manifest() });
    const [job] = await db.insert(pluginJobs).values({ pluginId, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY, schedule: "*/5 * * * *", status: "active" })
      .returning({ id: pluginJobs.id });
    jobId = job!.id;
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await fixture?.cleanup(); } }, 30_000);
  beforeEach(() => undefined);

  describe("grant create, read and revoke with revision checks", () => {
    it("create then read shows the retained grant and an enabled status", async () => {
      const setup = await seed();
      const grant = await createGrant(setup);
      expect(grant).toMatchObject({ revision: 1, enabled: true, maxItems: 5, importOnly: true, noDispatch: true, revokedAt: null, jobId });
      expect(await retainedGrant(setup)).toEqual(grant);
      await expect(setup.grants.read(setup.context, setup.scope)).resolves.toMatchObject({ status: "enabled", enabled: true });
    });

    it("refuses an expectedRevision that does not match the retained revision, and leaves the grant untouched", async () => {
      const setup = await seed();
      const first = await createGrant(setup);
      await expect(createGrant(setup, { expectedRevision: 0 })).rejects.toThrow(/revision changed/);
      await expect(createGrant(setup, { expectedRevision: 5 })).rejects.toThrow(/revision changed/);
      expect(await retainedGrant(setup)).toEqual(first);
    });

    it("increments the revision on every accepted write", async () => {
      const setup = await seed();
      const first = await createGrant(setup);
      const second = await createGrant(setup, { expectedRevision: 1, maxItems: 3 });
      expect([first.revision, second.revision]).toEqual([1, 2]);
      expect(second.maxItems).toBe(3);
      const revoked = await setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 2 });
      expect(revoked.revision).toBe(3);
    });

    it("refuses a revoke with a stale revision, then revokes with the current one and reads revoked", async () => {
      const setup = await seed();
      await createGrant(setup);
      await createGrant(setup, { expectedRevision: 1 });
      await expect(setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 1 })).rejects.toThrow(/revision changed/);
      await expect(setup.grants.read(setup.context, setup.scope)).resolves.toMatchObject({ status: "enabled" });

      const revoked = await setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 2 });
      expect(revoked).toMatchObject({ revision: 3, enabled: false, revokedByUserId: setup.userId });
      expect(revoked.revokedAt).not.toBeNull();
      await expect(setup.grants.read(setup.context, setup.scope)).resolves.toMatchObject({ status: "revoked", enabled: false });
      // A repeated revoke is idempotent and does not bump the revision.
      await expect(setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 3 })).resolves.toMatchObject({ revision: 3 });
    });

    it("refuses an expiry beyond the 24 hour cap and an expiry in the past", async () => {
      const setup = await seed();
      await expect(createGrant(setup, { expiresAt: new Date(Date.now() + GITHUB_PROJECT_GRANT_MAX_AGE_MS + 5 * 60_000).toISOString() }))
        .rejects.toThrow(/future and at most 24 hours/);
      await expect(createGrant(setup, { expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/future and at most 24 hours/);
      await expect(setup.grants.read(setup.context, setup.scope)).resolves.toMatchObject({ status: "absent" });
    });

    it("works through the HTTP route layer: create, stale refusal, read, revoke, read revoked", async () => {
      const setup = await seed();
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", source: "session", sessionId: "session-1", userId: setup.userId, isInstanceAdmin: false,
          companyIds: [setup.companyId], memberships: [{ companyId: setup.companyId, status: "active", membershipRole: "admin" }] } as never;
        next();
      });
      const router = express.Router();
      registerGitHubProjectScheduleGrantRoutes(router, db);
      app.use("/api", router);
      app.use(errorHandler);
      const base = `/api/plugins/${pluginId}/companies/${setup.companyId}/projects/${setup.projectId}/github-board/schedule-grant`;
      const body = { expectedRevision: 0, jobId, enabled: true, maxItems: 5, expiresAt: inHours(1) };

      const created = await request(app).post(base).send(body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ revision: 1, enabled: true });
      expect((await request(app).post(base).send(body)).status).toBe(409);
      expect((await request(app).get(base)).body).toMatchObject({ status: "enabled" });
      expect((await request(app).post(`${base}/revoke`).send({ expectedRevision: 0 })).status).toBe(409);
      const revoked = await request(app).post(`${base}/revoke`).send({ expectedRevision: 1 });
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ revision: 2, enabled: false });
      expect((await request(app).get(base)).body).toMatchObject({ status: "revoked" });
    });
  });

  describe("a revoked, expired or disabled grant is never used by a scheduled run", () => {
    const EXACT_ONE = "Exactly one current native board grant required for this company run";
    async function expireGrant(setup: Setup) {
      const grant = await retainedGrant(setup);
      await store().set(pluginId, { scopeKind: "company", ...stateOptions(setup.companyId), stateKey: `schedule-grant:${setup.projectId}`,
        value: { ...grant, grantedAt: new Date(Date.now() - 2 * HOUR).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() } });
    }
    async function bridgeRun(setup: Setup) {
      const reader = vi.fn();
      const bridge = createGitHubProjectBoardSchedulerBridge(db, reader as never, { enabled: true });
      const runId = await runRow(setup.companyId);
      const envelope = createPluginJobEnvelope(GITHUB_PROJECT_BOARD_JOB_KEY, runId, "schedule", new Date().toISOString(), setup.companyId);
      const outcome = await bridge.run({ id: jobId, pluginId, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY }, envelope, 20_000, () => true)
        .then(() => "ran", (error: Error) => error.message);
      return { bridge, reader, runId, outcome };
    }
    const prepare = {
      revoked: async (setup: Setup) => { await createGrant(setup); await setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 1 }); },
      disabled: async (setup: Setup) => { await createGrant(setup, { enabled: false }); },
      expired: async (setup: Setup) => { await createGrant(setup); await expireGrant(setup); },
    };

    it("selects the company of an enabled grant (control)", async () => {
      const setup = await seed();
      await createGrant(setup);
      const bridge = createGitHubProjectBoardSchedulerBridge(db, vi.fn() as never, { enabled: true });
      const plan = await bridge.resolveDispatch(pluginId, GITHUB_PROJECT_BOARD_JOB_KEY);
      expect(plan.scope).toBe("company");
      expect(plan.companyIds).toContain(setup.companyId);
    });

    it.each(["revoked", "disabled", "expired"] as const)("a %s grant selects no company and records the static refusal reason", async (kind) => {
      const setup = await seed();
      await prepare[kind](setup);
      const { bridge, reader, runId, outcome } = await bridgeRun(setup);
      expect((await bridge.resolveDispatch(pluginId, GITHUB_PROJECT_BOARD_JOB_KEY)).companyIds).not.toContain(setup.companyId);
      expect(outcome).toMatch(/refused or held/);
      expect(await logs(runId)).toEqual([{ schema: "native-github-board-scheduled-failure.v1", status: "refused", httpStatus: 403, reason: EXACT_ONE }]);
      expect(reader).not.toHaveBeenCalled();
      expect(await store().get(pluginId, "company", `schedule-lease:${setup.projectId}`, stateOptions(setup.companyId))).toBeNull();
    });

    it.each(["revoked", "disabled", "expired"] as const)("the scheduled run service refuses a %s grant itself and writes no lease", async (kind) => {
      const setup = await seed();
      await prepare[kind](setup);
      const { service, reader } = scheduledService(1);
      await expect(service.run(targetFor(setup, await runRow(setup.companyId)), custody())).rejects.toThrow(/Current enabled board schedule grant required/);
      expect(reader).not.toHaveBeenCalled();
      expect(await store().get(pluginId, "company", `schedule-lease:${setup.projectId}`, stateOptions(setup.companyId))).toBeNull();
    });
  });

  describe("one company's second grant never stops another company", () => {
    const EXACT_ONE = "Exactly one current native board grant required for this company run";
    function nativeBridge() {
      const reader = vi.fn(async (input: { authorizationDigest: string }) => ({ page: boardPage(1),
        account: { accountId: 42, login: "example" }, authorizationDigest: input.authorizationDigest }));
      return createGitHubProjectBoardSchedulerBridge(db, reader as never, { enabled: true });
    }
    async function bridgeRun(bridge: ReturnType<typeof nativeBridge>, companyId: string) {
      const runId = await runRow(companyId);
      const envelope = createPluginJobEnvelope(GITHUB_PROJECT_BOARD_JOB_KEY, runId, "schedule", new Date().toISOString(), companyId);
      const outcome = await bridge.run({ id: jobId, pluginId, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY }, envelope, 20_000, () => true)
        .then(value => value, (error: Error) => error.message);
      return { runId, outcome };
    }

    it("create refuses a second enabled grant in the same company and job, and allows it once the first is revoked", async () => {
      const setup = await seed();
      const second = await addBoundProject(setup);
      await createGrant(setup);
      await expect(setup.grants.create(setup.context, { ...second, expectedRevision: 0, jobId, enabled: true, maxItems: 5, expiresAt: inHours(1) }))
        .rejects.toThrow(/Another current board schedule grant exists/);
      await expect(setup.grants.read(setup.context, second)).resolves.toMatchObject({ status: "absent" });
      // A disabled grant cannot be scheduled, so it does not break the rule.
      await expect(setup.grants.create(setup.context, { ...second, expectedRevision: 0, jobId, enabled: false, maxItems: 5, expiresAt: inHours(1) }))
        .resolves.toMatchObject({ enabled: false });
      await setup.grants.revoke(setup.context, { ...setup.scope, expectedRevision: 1 });
      await expect(setup.grants.create(setup.context, { ...second, expectedRevision: 1, jobId, enabled: true, maxItems: 5, expiresAt: inHours(1) }))
        .resolves.toMatchObject({ revision: 2, enabled: true });
    });

    it("concurrent creates in one company: exactly one enabled grant results", async () => {
      const setup = await seed();
      const projectsInCompany = [setup.scope, ...await Promise.all([addBoundProject(setup), addBoundProject(setup), addBoundProject(setup)])];
      const body = { expectedRevision: 0, jobId, enabled: true, maxItems: 5, expiresAt: inHours(1) };
      const outcomes = await Promise.allSettled(projectsInCompany.map(scope => setup.grants.create(setup.context, { ...scope, ...body })));
      expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(3);
    });

    it("a company with two current grants (forced into the database) is excluded alone; the other companies still dispatch and import", async () => {
      const a = await seed(), b = await seed();
      const second = await addBoundProject(a);
      await createGrant(a);
      await createGrant(b);
      const first = await retainedGrant(a);
      await store().set(pluginId, { scopeKind: "company", ...stateOptions(a.companyId), stateKey: `schedule-grant:${second.projectId}`,
        value: { ...first, projectId: second.projectId, grantId: randomUUID() } });
      // Another company with an unreadable grant row must not stop anyone either.
      const brokenCompany = randomUUID();
      await store().set(pluginId, { scopeKind: "company", ...stateOptions(brokenCompany), stateKey: `schedule-grant:${randomUUID()}`,
        value: { nonsense: true } });

      const bridge = nativeBridge();
      const plan = await bridge.resolveDispatch(pluginId, GITHUB_PROJECT_BOARD_JOB_KEY);
      expect(plan.companyIds).toContain(b.companyId);
      expect(plan.companyIds).not.toContain(a.companyId);
      expect(plan.companyIds).not.toContain(brokenCompany);

      const ran = await bridgeRun(bridge, b.companyId);
      expect(ran.outcome).toMatchObject({ status: "verified", batchVerified: true, created: 1 });
      const refused = await bridgeRun(bridge, a.companyId);
      expect(refused.outcome).toMatch(/refused or held/);
      expect(await logs(refused.runId)).toEqual([{ schema: "native-github-board-scheduled-failure.v1", status: "refused", httpStatus: 403, reason: EXACT_ONE }]);
    });
  });

  describe("scheduled run lease", () => {
    it("lets exactly one of two concurrent runs claim the lease; the other is refused", async () => {
      const setup = await seed();
      await createGrant(setup);
      const gate = deferred();
      const { service, reader } = scheduledService(1, gate.promise);
      const run1 = await runRow(setup.companyId), run2 = await runRow(setup.companyId);
      const started = [service.run(targetFor(setup, run1), custody("epoch-a")), service.run(targetFor(setup, run2), custody("epoch-b"))]
        .map(promise => promise.then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error })));
      // The winner is parked in the page reader, so the first settled run must be the refused loser.
      const first = await Promise.race(started);
      expect(first.ok).toBe(false);
      expect((first as { error: Error }).error.message).toMatch(/Another active or uncertain native board lease is retained/);
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1), { timeout: 60_000 });
      gate.release();
      const results = await Promise.all(started);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toHaveLength(1);
      const winner = results.find(result => result.ok) as { ok: true; value: { status: string; created: number } };
      expect(winner.value).toMatchObject({ status: "verified", created: 1 });
      expect(await store().get(pluginId, "company", `schedule-lease:${setup.projectId}`, stateOptions(setup.companyId)))
        .toMatchObject({ status: "settled", revision: 1 });
    });

    it("lets a later run claim once the previous lease is settled, but never the same run twice", async () => {
      const setup = await seed();
      await createGrant(setup);
      const { service } = scheduledService(1);
      const run1 = await runRow(setup.companyId), run2 = await runRow(setup.companyId);
      await expect(service.run(targetFor(setup, run1), custody())).resolves.toMatchObject({ status: "verified" });
      await expect(service.run(targetFor(setup, run1), custody())).rejects.toThrow(/already consumed its lease/);
      await expect(service.run(targetFor(setup, run2), custody())).resolves.toMatchObject({ status: "verified", created: 0, reused: 1 });
    });

    it("expires a crashed run's lease and the next run resumes from the recorded progress index", async () => {
      const setup = await seed();
      await createGrant(setup, { maxItems: 1 });
      const { service } = scheduledService(2);
      const crashed = await runRow(setup.companyId), next = await runRow(setup.companyId);
      const leaseKey = `schedule-lease:${setup.projectId}`, progressKey = `schedule-progress:${setup.projectId}`;

      // Run 1 verifies one of two items, then "crashes" still holding an unexpired lease.
      await expect(service.run(targetFor(setup, crashed), custody("epoch-a"))).resolves.toMatchObject({
        status: "verified", created: 1, complete: false, progress: { verifiedForSnapshot: 1, pendingForSnapshot: 1 } });
      expect(await store().get(pluginId, "company", progressKey, stateOptions(setup.companyId))).toMatchObject({ nextIndex: 1, eligibleCount: 2 });
      const lease = await store().get(pluginId, "company", leaseKey, stateOptions(setup.companyId)) as Record<string, unknown>;
      const setLease = (value: Record<string, unknown>) => store().set(pluginId, { scopeKind: "company", ...stateOptions(setup.companyId),
        stateKey: leaseKey, value });
      await setLease({ ...lease, status: "active", expiresAt: new Date(Date.now() + 60_000).toISOString() });

      // While the lease is unexpired the next run is refused and progress is untouched.
      await expect(service.run(targetFor(setup, next), custody("epoch-b"))).rejects.toThrow(/Another active or uncertain native board lease/);
      expect(await store().get(pluginId, "company", progressKey, stateOptions(setup.companyId))).toMatchObject({ nextIndex: 1 });

      // Advance the clock past the lease expiry: the next run claims it and imports only the remaining item.
      await setLease({ ...lease, status: "active", expiresAt: new Date(Date.now() - 1000).toISOString() });
      await expect(service.run(targetFor(setup, next), custody("epoch-b"))).resolves.toMatchObject({
        status: "verified", created: 1, complete: true, progress: { verifiedForSnapshot: 2, pendingForSnapshot: 0, boardComplete: true } });
      expect(await store().get(pluginId, "company", progressKey, stateOptions(setup.companyId))).toMatchObject({ nextIndex: 2, phase: "complete" });
      expect(await store().get(pluginId, "company", leaseKey, stateOptions(setup.companyId)))
        .toMatchObject({ status: "settled", jobRunId: next, ownerEpoch: "epoch-b", revision: 2 });
    });
  });
});
