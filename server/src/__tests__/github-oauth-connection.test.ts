import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, companyMemberships, companySecrets, companySecretVersions,
  connectionGrants, createDb, heartbeatRuns, toolCatalogEntries, toolConnectionInstalls,
  toolApplications, toolConnections, toolOauthStates, toolProfileBindings,
} from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { createHttpLogger } from "../middleware/http-logger.js";
import pino from "pino";
import { githubOAuthToolDescriptors } from "../services/github-oauth-transport.js";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

// The endpoint guard remains real; only DNS evidence is synthetic. No network resolver runs.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: vi.fn(async () => [{ address: "140.82.113.6", family: 4 }]),
}));

type Db = ReturnType<typeof createDb>;
type Service = ReturnType<typeof toolAccessService>;
type Connection = typeof toolConnections.$inferSelect;
type Actor = { actorType: "user"; actorId: string; sessionId: string };
type Fixture = { companyId: string; secretId: string; actor: Actor; service: Service };
const CALLBACK = "https://paperclip.fixture.test:5113/api/tools/oauth/callback";
const USER = { id: 42, login: "synthetic-operator", type: "User" };
const token = (suffix = "initial") => ({ access_token: `synthetic-access-${suffix}`,
  refresh_token: `synthetic-refresh-${suffix}`, expires_in: 28800, token_type: "bearer", scope: "read:project,public_repo" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (payload: unknown, scopes: string | null = "read:project,public_repo") => Response.json(payload, {
  headers: scopes === null ? {} : { "X-OAuth-Scopes": scopes },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const io = {
  tokenPayload: token() as Record<string, unknown>, userPayload: USER as unknown,
  currentScopes: "read:project,public_repo" as string | null,
  tokenHandler: null as null | ((body: URLSearchParams) => Promise<Response>),
  userHandler: null as null | (() => Promise<Response>),
  calls: [] as Array<{ url: string; method: string; body: unknown }>,
};
function resetTransport() {
  io.tokenPayload = token(); io.userPayload = USER; io.currentScopes = "read:project,public_repo";
  io.tokenHandler = null; io.userHandler = null; io.calls = [];
}
function tokenCalls() { return io.calls.filter((call) => call.url === "https://github.com/login/oauth/access_token"); }
function writeCalls() { return io.calls.filter((call) => call.url.startsWith("https://api.github.com/repos/") && call.method !== "GET"); }
async function syntheticFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input); const method = init.method ?? "GET";
  io.calls.push({ url, method, body: init.body });
  if (url === "https://github.com/login/oauth/access_token" && method === "POST") {
    return io.tokenHandler ? io.tokenHandler(init.body as URLSearchParams) : json(io.tokenPayload);
  }
  if (url === "https://api.github.com/user" && method === "GET") {
    return io.userHandler ? io.userHandler() : json(io.userPayload, io.currentScopes);
  }
  if (url === "https://api.github.com/repos/synthetic-operator/synthetic-repo/issues" && method === "POST") {
    const body = JSON.parse(String(init.body));
    return json({ id: 100, number: 12, title: body.title, ...(body.body === undefined ? {} : { body: body.body }) });
  }
  if (url === "https://api.githubcopilot.com/mcp/" && method === "POST") {
    const body = JSON.parse(String(init.body));
    return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
  }
  throw new Error("Unexpected synthetic OAuth fixture endpoint; no provider call is permitted");
}

let db!: Db;
async function seed(): Promise<Fixture> {
  const [company] = await db.insert(companies).values({ name: `Synthetic OAuth ${randomUUID()}`,
    issuePrefix: `GO${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
  const actor: Actor = { actorType: "user", actorId: `synthetic-user-${randomUUID()}`, sessionId: `synthetic-session-${randomUUID()}` };
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId,
    status: "active", membershipRole: "operator" });
  const secret = await secretService(db).create(company.id, { name: "Synthetic OAuth client secret",
    provider: "local_encrypted", value: "synthetic-client-secret" }, { userId: actor.actorId });
  return { companyId: company.id, secretId: secret.id, actor, service: toolAccessService(db) };
}
function connectInput(fixture: Fixture) {
  return { galleryKey: "github", methodKey: "rest-oauth", name: "Synthetic GitHub OAuth",
    credentialValues: { "credentials.clientId": "synthetic-public-client" },
    credentialSecretRefs: [{ configPath: "oauth.client_secret", secretId: fixture.secretId,
      versionSelector: "latest" as const, required: true }],
    configValues: { expectedGitHubLogin: USER.login } };
}
async function begin(fixture: Fixture, connectionId?: string) {
  const id = connectionId ?? (await fixture.service.connectGalleryApp(fixture.companyId, connectInput(fixture), fixture.actor)).connectionId;
  const started = await fixture.service.startOAuth(fixture.companyId, id, { redirectUri: CALLBACK, actor: fixture.actor });
  return { id, state: new URL(started.authorizationUrl).searchParams.get("state")!, started };
}
function complete(fixture: Fixture, state: string, overrides: Record<string, unknown> = {}) {
  return fixture.service.completeOAuthCallback({ state, code: "synthetic-code", redirectUri: CALLBACK,
    actor: fixture.actor, ...overrides });
}
async function active(fixture: Fixture) {
  const started = await begin(fixture); await complete(fixture, started.state);
  return readConnection(started.id);
}
async function readConnection(id: string): Promise<Connection> {
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, id));
  if (!connection) throw new Error("Synthetic connection not found");
  return connection;
}
async function changeConnection(connection: Connection, config = connection.config, status = connection.status) {
  const [changed] = await db.update(toolConnections).set({ config, transportConfig: config, status,
    ...(status === "archived" ? { enabled: false } : {}), updatedAt: new Date(connection.updatedAt.getTime() + 1000) })
    .where(eq(toolConnections.id, connection.id)).returning();
  return changed;
}
async function existingVersions(connection: Connection) {
  const ids = connection.credentialSecretRefs.map((ref) => ref.secretId);
  return Promise.all(ids.map(async (id) => {
    const [secret] = await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion })
      .from(companySecrets).where(eq(companySecrets.id, id));
    return secret;
  }));
}
async function expectNoAgentEffects(companyId: string, expectedRunIds: string[] = []) {
  const rows = await Promise.all([
    db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
    db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)),
    db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId)),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
  ]);
  for (const [index, records] of rows.entries()) {
    if (index === 3) expect(records.map((record) => record.id).sort()).toEqual([...expectedRunIds].sort());
    else expect(records).toHaveLength(0);
  }
}
function securitySnapshot(connection: Connection) {
  const configWithoutLease = (config: Record<string, unknown>) => {
    const { refreshLease: _lease, ...oauth } = config.oauth as Record<string, unknown>;
    return { ...config, oauth };
  };
  return { applicationId: connection.applicationId, transport: connection.transport, authKind: connection.authKind,
    status: connection.status, enabled: connection.enabled, ownership: connection.ownership,
    config: configWithoutLease(connection.config), transportConfig: configWithoutLease(connection.transportConfig),
    credentialSecretRefs: connection.credentialSecretRefs, credentialRefs: connection.credentialRefs };
}
async function waitForHold(entered: Promise<void>, observed: Promise<unknown>) {
  await Promise.race([entered, observed.then(() => { throw new Error("Synthetic operation did not reach its expected hold"); })]);
}
function routeActor(fixture: Fixture, overrides: Partial<Express.Request["actor"]> = {}): Express.Request["actor"] {
  return { type: "board", userId: fixture.actor.actorId, sessionId: fixture.actor.sessionId, userName: "Synthetic operator",
    userEmail: null, isInstanceAdmin: false, source: "session", companyIds: [fixture.companyId],
    memberships: [{ companyId: fixture.companyId, membershipRole: "operator", status: "active" }], ...overrides } as Express.Request["actor"];
}
function routeApp(actor: Express.Request["actor"]) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
  return app;
}
async function reviewedWrite(connection: Connection) {
  const [entry] = await db.update(toolCatalogEntries).set({ status: "active", quarantinedAt: null, quarantineReason: null })
    .where(and(eq(toolCatalogEntries.connectionId, connection.id), eq(toolCatalogEntries.toolName, "github_create_issue"))).returning();
  if (!entry) throw new Error("Synthetic catalog action not found");
  return entry;
}

describe("native GitHub OAuth service and routes (mandatory private PostgreSQL)", () => {
  let native: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
  beforeAll(async () => { native = await startBoardImportFixtureDatabase(); db = createDb(native.connectionString); }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await native?.cleanup(); }, 25_000);
  beforeEach(() => {
    resetTransport();
    // Public, synthetic key: the provider's env-first branch prevents any key-file fallback.
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.fixture.test:5113");
    vi.stubGlobal("fetch", vi.fn(syntheticFetch));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  // Data, encrypted synthetic secrets and fixture logs remain intact after the cluster stops.

  it("connects only the selected method and a same-company saved secret without agent effects", async () => {
    const fixture = await seed(); const other = await seed();
    await expect(fixture.service.connectGalleryApp(fixture.companyId, { ...connectInput(fixture),
      credentialSecretRefs: [{ configPath: "oauth.client_secret", secretId: other.secretId }] }, fixture.actor))
      .rejects.toMatchObject({ status: 422 });
    await expect(fixture.service.connectGalleryApp(fixture.companyId, { ...connectInput(fixture), methodKey: "unknown-method" }, fixture.actor))
      .rejects.toMatchObject({ status: 422 });
    const connected = await fixture.service.connectGalleryApp(fixture.companyId, connectInput(fixture), fixture.actor);
    expect(connected.connection).toMatchObject({ companyId: fixture.companyId, transport: "rest_api", authKind: "oauth",
      status: "draft", enabled: false, config: { methodKey: "rest-oauth", sourceTemplateKey: "github",
        oauth: { clientId: "synthetic-public-client" }, expectedGitHubLogin: USER.login } });
    expect(JSON.stringify(connected)).not.toContain("synthetic-client-secret");
    expect(connected.connection.credentialSecretRefs[0].secretId).toBe(fixture.secretId);
    expect(tokenCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
  });

  it("runs the actual setup/connect/callback routes with finite expiry, PKCE and private token storage", async () => {
    const fixture = await seed(); const app = routeApp(routeActor(fixture));
    const setup = await request(app).get(`/api/companies/${fixture.companyId}/tools/github/oauth/setup`).expect(200);
    expect(setup.body.callbackUrl).toBe(CALLBACK);
    expect(setup.body.requestedScopes).toEqual(["read:project", "public_repo", "offline_access"]);
    expect(setup.body.privateRepoRequestedScopes).toEqual(["repo", "project", "offline_access"]);
    const connected = await request(app).post(`/api/companies/${fixture.companyId}/tools/apps/connect`).send(connectInput(fixture)).expect(201);
    const consent = new URL(connected.body.auth.startUrl);
    expect(consent.origin + consent.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(consent.searchParams.get("redirect_uri")).toBe(CALLBACK); expect(consent.searchParams.get("login")).toBe(USER.login);
    // Least access by default: no `repo` (private repositories) without an explicit opt-in.
    expect(consent.searchParams.get("scope")).toBe("read:project public_repo offline_access");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256"); expect(consent.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    const callback = await request(app).get("/api/tools/oauth/callback").set("Accept", "application/json")
      .query({ state: consent.searchParams.get("state"), code: "synthetic-code" }).expect(200);
    expect(tokenCalls()).toHaveLength(1);
    const body = tokenCalls()[0].body as URLSearchParams;
    expect(body.get("client_id")).toBe("synthetic-public-client"); expect(body.get("redirect_uri")).toBe(CALLBACK);
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(consent.searchParams.get("code_challenge"));
    expect(body.get("client_secret")).toBe("synthetic-client-secret");
    const saved = await readConnection(connected.body.connectionId);
    const oauth = saved.config.oauth as Record<string, unknown>;
    expect(Date.parse(String(oauth.expiresAt)) - Date.now()).toBeGreaterThan(28_700_000);
    expect(saved.config.providerMetadata).toMatchObject({ githubOAuth: { accountId: 42, login: USER.login, grantedScopes: ["read:project", "public_repo"] } });
    expect(JSON.stringify(callback.body)).not.toContain("synthetic-access-initial");
    expect(callback.body.catalog).toHaveLength(githubOAuthToolDescriptors().length);
    expect(callback.body.catalog.every((entry: { status: string }) => entry.status === "quarantined")).toBe(true);
    const access = saved.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token")!;
    const [encrypted] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, access.secretId));
    expect(encrypted.valueSha256).toBe(hash("synthetic-access-initial"));
    expect(JSON.stringify(encrypted.material)).not.toContain("synthetic-access-initial");
    await expectNoAgentEffects(fixture.companyId);
  });

  it("requests full repo/project only after an explicit private-repository opt-in and then requires that grant", async () => {
    for (const optIn of [false, "true", 1] as const) {
      resetTransport(); const fixture = await seed();
      const connected = await fixture.service.connectGalleryApp(fixture.companyId, { ...connectInput(fixture),
        configValues: { expectedGitHubLogin: USER.login, githubPrivateRepoAccess: optIn } }, fixture.actor);
      expect(connected.connection.config.githubPrivateRepoAccess).toBe(false);
      const begun = await begin(fixture, connected.connectionId);
      expect(new URL(begun.started.authorizationUrl).searchParams.get("scope")).toBe("read:project public_repo offline_access");
    }
    resetTransport(); const fixture = await seed();
    const connected = await fixture.service.connectGalleryApp(fixture.companyId, { ...connectInput(fixture),
      configValues: { expectedGitHubLogin: USER.login, githubPrivateRepoAccess: true } }, fixture.actor);
    expect(connected.connection.config).toMatchObject({ githubPrivateRepoAccess: true,
      oauth: { scopes: ["repo", "project", "offline_access"] } });
    const begun = await begin(fixture, connected.connectionId);
    expect(new URL(begun.started.authorizationUrl).searchParams.get("scope")).toBe("repo project offline_access");
    io.tokenPayload.scope = "read:project,public_repo"; io.currentScopes = "read:project,public_repo";
    await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 422 });
    resetTransport(); io.tokenPayload.scope = "repo,project"; io.currentScopes = "repo,project";
    const retry = await begin(fixture, connected.connectionId);
    await complete(fixture, retry.state);
    expect((await readConnection(connected.connectionId)).config.providerMetadata)
      .toMatchObject({ githubOAuth: { grantedScopes: ["repo", "project"] } });
    await expectNoAgentEffects(fixture.companyId);
  });

  it("refuses a default connection whose grant is wider than chosen with a 422 and stores nothing", async () => {
    const fixture = await seed(); const app = routeApp(routeActor(fixture));
    const connected = await request(app).post(`/api/companies/${fixture.companyId}/tools/apps/connect`).send(connectInput(fixture)).expect(201);
    expect((await readConnection(connected.body.connectionId)).config.githubPrivateRepoAccess).toBe(false);
    const before = await readConnection(connected.body.connectionId);
    // An earlier, broader consent makes GitHub return full repo access for a public-only request.
    io.tokenPayload.scope = "repo,project"; io.currentScopes = "repo,project";
    const consent = new URL(connected.body.auth.startUrl);
    const refused = await request(app).get("/api/tools/oauth/callback").set("Accept", "application/json")
      .query({ state: consent.searchParams.get("state"), code: "synthetic-code" }).expect(422);
    expect(refused.body.code).toBe("github_oauth_scopes_too_broad");
    expect(refused.body.error).toContain("Include private repositories");
    expect(refused.body.error).toContain("revoke");
    expect(JSON.stringify(refused.body)).not.toContain("synthetic-access-initial");
    const after = await readConnection(connected.body.connectionId);
    expect(after.config.providerMetadata ?? null).toEqual(before.config.providerMetadata ?? null);
    expect(after.credentialSecretRefs.filter((ref) => ref.configPath === "oauth.access_token")).toEqual([]);
    expect(after.status).toBe(before.status);
    await expectNoAgentEffects(fixture.companyId);
  });

  it("keeps GitHub private-repo access and OAuth state across a generic PATCH and refuses changing them there", async () => {
    resetTransport(); const fixture = await seed(); const app = routeApp(routeActor(fixture));
    const connected = await fixture.service.connectGalleryApp(fixture.companyId, connectInput(fixture), fixture.actor);
    // Least access, but saved scopes include full repo: dropping the flag would re-derive private access.
    const seeded = await changeConnection(await readConnection(connected.connectionId), { ...(await readConnection(connected.connectionId)).config,
      githubPrivateRepoAccess: false, oauth: { ...((await readConnection(connected.connectionId)).config.oauth as Record<string, unknown>),
        scopes: ["repo", "project", "offline_access"] }, providerMetadata: { githubOAuth: { grantedScopes: ["repo", "project"] } } });
    // PATCH replaces config whole; a generic edit that omits the three protected keys must keep them.
    const { githubPrivateRepoAccess: _f, oauth: _o, providerMetadata: _p, ...editable } = seeded.config;
    await request(app).patch(`/api/tool-connections/${seeded.id}`).send({ config: { ...editable, expectedGitHubLogin: "x" } }).expect(200);
    const kept = await readConnection(seeded.id);
    expect(kept.config.expectedGitHubLogin).toBe("x");
    expect(kept.config.githubPrivateRepoAccess).toBe(false);
    expect(kept.config.oauth).toEqual(seeded.config.oauth); expect(kept.config.providerMetadata).toEqual(seeded.config.providerMetadata);
    expect(kept.transportConfig.githubPrivateRepoAccess).toBe(false);
    const begun = await begin(fixture, seeded.id);
    expect(new URL(begun.started.authorizationUrl).searchParams.get("scope")).toBe("read:project public_repo offline_access");
    // A whole-config round trip that echoes the stored values is accepted, and a config that omits the
    // identity keys still leaves a GitHub connection.
    await request(app).patch(`/api/tool-connections/${seeded.id}`).send({ config: { ...(await readConnection(seeded.id)).config, note: "n" } }).expect(200);
    const { sourceTemplateKey: _s, methodKey: _m, ...noIdentity } = editable;
    await request(app).patch(`/api/tool-connections/${seeded.id}`).send({ config: noIdentity }).expect(200);
    expect((await readConnection(seeded.id)).config).toMatchObject({ sourceTemplateKey: "github", methodKey: "rest-oauth", githubPrivateRepoAccess: false });
    const before = await readConnection(seeded.id);
    await request(app).patch(`/api/tool-connections/${seeded.id}`).send({ config: { ...editable, methodKey: "synthetic-other" } }).expect(400);
    for (const config of [{ githubPrivateRepoAccess: true }, { githubPrivateRepoAccess: null }, { githubPrivateRepoAccess: "false" }, { oauth: { scopes: ["repo", "project", "offline_access"] } },
      { providerMetadata: { githubOAuth: { grantedScopes: ["repo"] } } }]) {
      const refused = await request(app).patch(`/api/tool-connections/${seeded.id}`).send({ config }).expect(400);
      expect(refused.body.error).toContain("reconnecting");
      expect((await readConnection(seeded.id)).config).toEqual(before.config);
    }
  });

  it("derives a legacy flagless connection's access from its saved scopes on reconnect", async () => {
    for (const [scopes, expected] of [[["repo", "project", "offline_access"], "repo project offline_access"],
      [["read:project", "public_repo", "offline_access"], "read:project public_repo offline_access"]] as const) {
      resetTransport(); const fixture = await seed();
      const connected = await fixture.service.connectGalleryApp(fixture.companyId, connectInput(fixture), fixture.actor);
      const row = await readConnection(connected.connectionId);
      const { githubPrivateRepoAccess: _flag, ...legacy } = row.config;
      const saved = await changeConnection(row, { ...legacy, oauth: { ...(row.config.oauth as Record<string, unknown>), scopes: [...scopes] } });
      expect("githubPrivateRepoAccess" in saved.config).toBe(false);
      const begun = await begin(fixture, saved.id);
      expect(new URL(begun.started.authorizationUrl).searchParams.get("scope")).toBe(expected);
    }
  });

  it("leaves a non-GitHub connection PATCH unchanged", async () => {
    const fixture = await seed(); const app = routeApp(routeActor(fixture));
    const connected = await fixture.service.connectGalleryApp(fixture.companyId, connectInput(fixture), fixture.actor);
    const row = await readConnection(connected.connectionId);
    const other = await changeConnection(row, { ...row.config, methodKey: "synthetic-other", oauth: { scopes: ["a"] } });
    const next = { ...other.config, oauth: { scopes: ["b"] }, githubPrivateRepoAccess: true, note: "n" };
    await request(app).patch(`/api/tool-connections/${other.id}`).send({ config: next }).expect(200);
    expect((await readConnection(other.id)).config).toEqual(next);
  });

  it("never writes access, refresh or client-secret values to the server logger or console", async () => {
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    const spies = [...levels.map((level) => vi.spyOn(logger, level)),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))];
    // The production HTTP logger factory on a capturing pino sink, so the 422 entry is observed, not assumed.
    const lines: string[] = [];
    const sink = pino({ level: "trace" }, { write: (line: string) => { lines.push(line); } });
    try {
      const fixture = await seed();
      const app = express(); app.use(express.json()); app.use(createHttpLogger(sink));
      app.use((req, _res, next) => { req.actor = routeActor(fixture); next(); });
      app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
      const connected = await request(app).post(`/api/companies/${fixture.companyId}/tools/apps/connect`).send(connectInput(fixture)).expect(201);
      const consent = new URL(connected.body.auth.startUrl);
      await request(app).get("/api/tools/oauth/callback").set("Accept", "application/json")
        .query({ state: consent.searchParams.get("state"), code: "synthetic-code" }).expect(200);
      // A failing callback goes through the real error handler and HTTP logger.
      resetTransport(); io.userPayload = { ...USER, id: 43 };
      const again = await fixture.service.startOAuth(fixture.companyId, connected.body.connectionId, { redirectUri: CALLBACK, actor: fixture.actor });
      await request(app).get("/api/tools/oauth/callback").set("Accept", "application/json")
        .query({ state: new URL(again.authorizationUrl).searchParams.get("state"), code: "synthetic-code" }).expect(422);
      await vi.waitFor(() => {
        const entries = lines.map((line) => JSON.parse(line) as { level: number; msg?: string; res?: { statusCode?: number } });
        const failed = entries.filter((entry) => entry.res?.statusCode === 422);
        expect(failed).toHaveLength(1);
        expect(failed[0].level).toBe(40); // pino "warn"
        expect(failed[0].msg).toContain("/api/tools/oauth/callback 422");
      });
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls), (_key, value) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value) + lines.join("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const secret of ["synthetic-access-initial", "synthetic-refresh-initial", "synthetic-client-secret"]) {
        expect(logged).not.toContain(secret);
      }
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });

  it("keeps the omitted-method GitHub PAT path separate and does not borrow global OAuth clients", async () => {
    const fixture = await seed();
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_GITHUB_CLIENT_ID", "synthetic-wrong-global-client");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_GITHUB_CLIENT_SECRET", "synthetic-wrong-global-secret");
    const begun = await begin(fixture);
    expect(new URL(begun.started.authorizationUrl).searchParams.get("client_id")).toBe("synthetic-public-client");
    const pat = await fixture.service.connectGalleryApp(fixture.companyId, { galleryKey: "github", name: "Synthetic PAT",
      credentialValues: { "credentials.authorization": "synthetic-pat" } }, fixture.actor);
    expect(pat.connection.transport).toBe("mcp_remote"); expect(pat.connection.authKind).toBe("api_key");
    expect(pat.auth ?? null).toBeNull(); expect(tokenCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
  });

  it("rejects anonymous, different user/session, viewer and foreign-company callbacks without consuming state", async () => {
    const fixture = await seed(); const begun = await begin(fixture);
    const actors: Express.Request["actor"][] = [
      { type: "none", source: "none" }, routeActor(fixture, { userId: "synthetic-other-user" }),
      routeActor(fixture, { sessionId: "synthetic-other-session" }),
      routeActor(fixture, { memberships: [{ companyId: fixture.companyId, membershipRole: "viewer", status: "active" }] }),
      routeActor(fixture, { companyIds: [], memberships: [] }),
    ];
    for (const actor of actors) await request(routeApp(actor)).get("/api/tools/oauth/callback")
      .set("Accept", "application/json").query({ state: begun.state, code: "synthetic-code" }).expect(403);
    expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, begun.state))).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(0); await complete(fixture, begun.state); await expectNoAgentEffects(fixture.companyId);
  });

  it("refuses absent, expired and actor-mismatched state before any token exchange", async () => {
    const fixture = await seed(); const begun = await begin(fixture);
    await expect(complete(fixture, "synthetic-unknown-state")).rejects.toMatchObject({ status: 400 });
    await expect(complete(fixture, begun.state, { actor: { ...fixture.actor, sessionId: "wrong-session" } }))
      .rejects.toMatchObject({ status: 403 });
    await db.update(toolOauthStates).set({ expiresAt: new Date(0) }).where(eq(toolOauthStates.state, begun.state));
    await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 400 });
    expect(tokenCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
  });

  it("rejects changed client and callback bindings before exchanging the code", async () => {
    for (const change of ["client", "callback"] as const) {
      const fixture = await seed(); const begun = await begin(fixture); const saved = await readConnection(begun.id);
      if (change === "client") await changeConnection(saved, { ...saved.config,
        oauth: { ...(saved.config.oauth as object), clientId: "synthetic-new-client" } });
      await expect(complete(fixture, begun.state, change === "callback" ? { redirectUri: CALLBACK.replace("5113", "8443") } : {}))
        .rejects.toMatchObject({ status: 409 });
      expect(tokenCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("refuses wrong account, incomplete grant or invalid expiry without rotating existing credentials", async () => {
    const changes = ["login", "account-id", "missing-scope", "missing-public-repo", "missing-expiry", "bad-expiry", "missing-refresh"];
    for (const change of changes) {
      resetTransport(); const fixture = await seed(); const saved = await active(fixture);
      const versions = await existingVersions(saved); const begun = await begin(fixture, saved.id);
      if (change === "login") io.userPayload = { ...USER, login: "synthetic-other" };
      if (change === "account-id") io.userPayload = { ...USER, id: 43 };
      if (change === "missing-scope") delete io.tokenPayload.scope;
      if (change === "missing-public-repo") io.tokenPayload.scope = "read:project";
      if (change === "missing-expiry") delete io.tokenPayload.expires_in;
      if (change === "bad-expiry") io.tokenPayload.expires_in = 86401;
      if (change === "missing-refresh") delete io.tokenPayload.refresh_token;
      await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 422 });
      expect(await existingVersions(saved)).toEqual(versions); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("checks the provider's current scope header rather than blessing cached grant metadata", async () => {
    for (const scope of [null, "read:project", "repo,project,invalid scope!"]) {
      resetTransport(); const fixture = await seed(); const begun = await begin(fixture); io.currentScopes = scope;
      await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 422 });
      const saved = await readConnection(begun.id);
      expect(saved.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(false);
      expect(saved.enabled).toBe(false); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("atomically consumes concurrent same-state callbacks once and refuses a later replay", async () => {
    const fixture = await seed(); const begun = await begin(fixture);
    const outcomes = await Promise.allSettled([complete(fixture, begun.state), complete(fixture, begun.state)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(1);
    await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 400 });
    expect(tokenCalls()).toHaveLength(1); await expectNoAgentEffects(fixture.companyId);
  });

  it("holds a pending token exchange if the client changes and preserves previous credential versions", async () => {
    const fixture = await seed(); const saved = await active(fixture); const versions = await existingVersions(saved);
    const begun = await begin(fixture, saved.id); const entered = deferred<void>(); const release = deferred<Response>();
    io.tokenHandler = async () => { entered.resolve(); return release.promise; };
    const pending = complete(fixture, begun.state); const observed = pending.catch((error) => error);
    await waitForHold(entered.promise, observed); const current = await readConnection(saved.id);
    const changed = await changeConnection(current, { ...current.config, oauth: { ...(current.config.oauth as object), clientId: "synthetic-new-client" } });
    release.resolve(json(token("changed-client"))); expect(await observed).toMatchObject({ status: 409 });
    expect((await readConnection(saved.id)).config).toEqual(changed.config);
    expect(await existingVersions(saved)).toEqual(versions); await expectNoAgentEffects(fixture.companyId);
  });

  it("does not resurrect an archived connection when an account response arrives late", async () => {
    const fixture = await seed(); const saved = await active(fixture); const versions = await existingVersions(saved);
    const begun = await begin(fixture, saved.id); const entered = deferred<void>(); const release = deferred<Response>();
    io.userHandler = async () => { entered.resolve(); return release.promise; };
    const pending = complete(fixture, begun.state); const observed = pending.catch((error) => error);
    await waitForHold(entered.promise, observed); await changeConnection(await readConnection(saved.id), undefined, "archived");
    release.resolve(json(USER)); expect(await observed).toMatchObject({ status: 409 });
    expect(await readConnection(saved.id)).toMatchObject({ status: "archived", enabled: false });
    expect(await existingVersions(saved)).toEqual(versions); await expectNoAgentEffects(fixture.companyId);
  });

  it("preserves an independently archived or disabled app and its old connection across late OAuth responses", async () => {
    for (const stage of ["token", "user"] as const) for (const status of ["archived", "disabled"] as const) {
      resetTransport(); const fixture = await seed(); const saved = await active(fixture);
      const versions = await existingVersions(saved); const begun = await begin(fixture, saved.id);
      const previous = await readConnection(saved.id); const entered = deferred<void>(); const release = deferred<Response>();
      const hold = async () => { entered.resolve(); return release.promise; };
      if (stage === "token") io.tokenHandler = hold; else io.userHandler = hold;
      const pending = complete(fixture, begun.state); const observed = pending.catch((error) => error);
      await waitForHold(entered.promise, observed);
      // Change only the parent application through its native service, never the connection.
      await fixture.service.updateApplication(previous.applicationId, { status });
      const [heldApp] = await db.select().from(toolApplications).where(eq(toolApplications.id, previous.applicationId));
      expect(heldApp.status).toBe(status); expect(await readConnection(saved.id)).toEqual(previous);
      release.resolve(stage === "token" ? json(token("held-application")) : json(USER));
      expect(await observed).toMatchObject({ status: 409 });
      const [afterApp] = await db.select().from(toolApplications).where(eq(toolApplications.id, previous.applicationId));
      expect(afterApp).toEqual(heldApp); expect(await readConnection(saved.id)).toEqual(previous);
      expect(await existingVersions(saved)).toEqual(versions); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("preserves the rotated refresh token when subsequent account verification fails", async () => {
    const fixture = await seed(); const saved = await active(fixture);
    const versions = await existingVersions(saved);
    const refresh = saved.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    const access = saved.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token")!;
    await changeConnection(saved, { ...saved.config, oauth: { ...(saved.config.oauth as object), expiresAt: new Date(0).toISOString() } });
    io.tokenPayload = token("rotated"); io.userHandler = async () => { throw new Error("Synthetic identity transport failure"); };
    const beforeTokenCount = tokenCalls().length;
    await expect(fixture.service.checkHealth(saved.id, fixture.actor)).rejects.toMatchObject({ status: 502 });
    expect(tokenCalls()).toHaveLength(beforeTokenCount + 1);
    expect((tokenCalls().at(-1)!.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
    const current = await readConnection(saved.id);
    const retained = current.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    expect(retained.secretId).not.toBe(refresh.secretId);
    const [latest] = await db.select().from(companySecrets).where(eq(companySecrets.id, retained.secretId));
    const [version] = await db.select().from(companySecretVersions).where(and(eq(companySecretVersions.secretId, retained.secretId), eq(companySecretVersions.version, latest.latestVersion)));
    expect(version.valueSha256).toBe(hash("synthetic-refresh-rotated"));
    const [oldAccess] = await db.select().from(companySecrets).where(eq(companySecrets.id, access.secretId));
    expect(oldAccess.latestVersion).toBe(1); expect(await existingVersions(saved)).toEqual(versions);
    expect((current.config.oauth as Record<string, unknown>).refreshLease).toBeUndefined();
    await expectNoAgentEffects(fixture.companyId);
  });

  it("refuses late refresh adoption after connection or application changes, including timestamp collisions", async () => {
    const changes = ["client", "same-timestamp", "connection-archived", "app-archived", "app-disabled",
      "bad-token-archived", "bad-token-config"] as const;
    for (const stage of ["token", "user"] as const) for (const change of changes) {
      const badRefresh = change === "bad-token-archived" || change === "bad-token-config";
      if (badRefresh && stage === "user") continue; // A terminal token response must not reach GET user.
      resetTransport(); const fixture = await seed(); const saved = await active(fixture);
      const versions = await existingVersions(saved);
      await changeConnection(saved, { ...saved.config, oauth: { ...(saved.config.oauth as object), expiresAt: new Date(0).toISOString() } });
      const entered = deferred<void>(); const release = deferred<Response>();
      const hold = async () => { entered.resolve(); return release.promise; };
      if (stage === "token") io.tokenHandler = hold; else io.userHandler = hold;
      const pending = fixture.service.checkHealth(saved.id, fixture.actor); const observed = pending.catch((error) => error);
      await waitForHold(entered.promise, observed); const current = await readConnection(saved.id);
      if (change === "client") await changeConnection(current, { ...current.config,
        oauth: { ...(current.config.oauth as object), clientId: "synthetic-refresh-new-client" } });
      else if (change === "same-timestamp") await db.update(toolConnections).set({
        config: { ...current.config, expectedGitHubLogin: "synthetic-other" },
        transportConfig: { ...current.transportConfig, expectedGitHubLogin: "synthetic-other" },
      }).where(eq(toolConnections.id, current.id));
      else if (change === "connection-archived" || change === "bad-token-archived") await changeConnection(current, undefined, "archived");
      else if (change === "bad-token-config") {
        const replacement = await secretService(db).create(fixture.companyId, { name: "Synthetic refresh race replacement",
          provider: "local_encrypted", value: "synthetic-new-access-ref" }, { userId: fixture.actor.actorId });
        await db.update(toolConnections).set({ config: { ...current.config, expectedGitHubLogin: "synthetic-other" },
          transportConfig: { ...current.transportConfig, expectedGitHubLogin: "synthetic-other" },
          credentialSecretRefs: current.credentialSecretRefs.map((ref) => ref.configPath === "oauth.access_token" ? { ...ref, secretId: replacement.id } : ref),
          credentialRefs: current.credentialRefs.map((ref) => ref.name === "oauth.access_token" ? { ...ref, secretId: replacement.id } : ref),
        }).where(eq(toolConnections.id, current.id));
      }
      else await fixture.service.updateApplication(current.applicationId, { status: change === "app-archived" ? "archived" : "disabled" });
      const held = await readConnection(saved.id);
      const [heldApp] = await db.select().from(toolApplications).where(eq(toolApplications.id, held.applicationId));
      release.resolve(badRefresh ? Response.json({ error: "bad_refresh_token" }, { status: 400 })
        : stage === "token" ? json(token("late-refresh")) : json(USER));
      expect(await observed).toMatchObject({ status: 502, details: { code: "oauth_refresh_superseded" } });
      expect(securitySnapshot(await readConnection(saved.id))).toEqual(securitySnapshot(held));
      const [afterApp] = await db.select().from(toolApplications).where(eq(toolApplications.id, held.applicationId));
      expect(afterApp).toEqual(heldApp); expect(await existingVersions(saved)).toEqual(versions);
      expect(writeCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("refuses a bound connector downgrade without I/O and same-timestamp callback snapshot changes", async () => {
    for (const change of ["downgrade", "same-timestamp"] as const) {
      resetTransport(); const fixture = await seed(); const saved = await active(fixture);
      const versions = await existingVersions(saved); const begun = await begin(fixture, saved.id); resetTransport();
      if (change === "downgrade") {
        await db.update(toolConnections).set({ transport: "mcp_remote", authKind: "api_key" }).where(eq(toolConnections.id, saved.id));
        const held = await readConnection(saved.id); vi.mocked(lookup).mockClear();
        await expect(complete(fixture, begun.state)).rejects.toMatchObject({ status: 409 });
        expect(io.calls).toHaveLength(0); expect(lookup).not.toHaveBeenCalled(); expect(await readConnection(saved.id)).toEqual(held);
      } else {
        const entered = deferred<void>(); const release = deferred<Response>();
        io.tokenHandler = async () => { entered.resolve(); return release.promise; };
        const observed = complete(fixture, begun.state).catch((error) => error); await waitForHold(entered.promise, observed);
        const current = await readConnection(saved.id);
        await db.update(toolConnections).set({ config: { ...current.config, expectedGitHubLogin: "synthetic-other" },
          transportConfig: { ...current.transportConfig, expectedGitHubLogin: "synthetic-other" } }).where(eq(toolConnections.id, current.id));
        const held = await readConnection(saved.id); expect(held.updatedAt).toEqual(current.updatedAt);
        release.resolve(json(token("timestamp-collision"))); expect(await observed).toMatchObject({ status: 409 });
        expect(await readConnection(saved.id)).toEqual(held);
      }
      expect(await existingVersions(saved)).toEqual(versions); await expectNoAgentEffects(fixture.companyId);
    }
  });

  it("uses one verified credential for dispatch and checks the internal authorization hook", async () => {
    const fixture = await seed(); const saved = await active(fixture); const entry = await reviewedWrite(saved);
    const beforeDispatch = vi.fn(async () => undefined);
    const result = await fixture.service.executeGitHubOAuthTool({ companyId: fixture.companyId, connectionId: saved.id,
      catalogEntryId: entry.id, toolName: "github_create_issue", parameters: { owner: USER.login, repo: "synthetic-repo", title: "Synthetic issue" },
      actor: fixture.actor, beforeDispatch });
    expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(writeCalls()).toHaveLength(1);
    expect(result.isError).toBe(false); await expectNoAgentEffects(fixture.companyId);
  });

  it("does not dispatch after credentials or account change during GET user", async () => {
    const fixture = await seed(); const saved = await active(fixture); const entry = await reviewedWrite(saved);
    const entered = deferred<void>(); const release = deferred<Response>();
    io.userHandler = async () => { entered.resolve(); return release.promise; };
    const beforeDispatch = vi.fn(async () => undefined);
    const pending = fixture.service.executeGitHubOAuthTool({ companyId: fixture.companyId, connectionId: saved.id,
      catalogEntryId: entry.id, toolName: "github_create_issue", parameters: { owner: USER.login, repo: "synthetic-repo", title: "Synthetic issue" }, actor: fixture.actor, beforeDispatch });
    const observed = pending.catch((error) => error); await waitForHold(entered.promise, observed);
    const current = await readConnection(saved.id);
    const replacement = await secretService(db).create(fixture.companyId, { name: "Synthetic replacement account token",
      provider: "local_encrypted", value: "synthetic-other-account-access" }, { userId: fixture.actor.actorId });
    const config = { ...current.config, expectedGitHubLogin: "synthetic-other",
      providerMetadata: { githubOAuth: { accountId: 43, login: "synthetic-other" } } };
    await db.update(toolConnections).set({ config, transportConfig: config,
      credentialSecretRefs: current.credentialSecretRefs.map((ref) => ref.configPath === "oauth.access_token"
        ? { ...ref, secretId: replacement.id } : ref),
      credentialRefs: current.credentialRefs.map((ref) => ref.name === "oauth.access_token"
        ? { ...ref, secretId: replacement.id } : ref), updatedAt: new Date(current.updatedAt.getTime() + 1000),
    }).where(eq(toolConnections.id, current.id));
    release.resolve(json(USER)); expect(await observed).toMatchObject({ status: 409 });
    expect(writeCalls()).toHaveLength(0); expect(beforeDispatch).not.toHaveBeenCalled(); await expectNoAgentEffects(fixture.companyId);
  });

  it("rechecks paused or terminated agents and terminal runs immediately before dispatch", async () => {
    for (const change of ["paused", "terminated", "error", "pending_approval", "run-cancelled"] as const) {
      resetTransport(); const fixture = await seed(); const saved = await active(fixture); const entry = await reviewedWrite(saved);
      const [agent] = await db.insert(agents).values({ companyId: fixture.companyId, name: "Synthetic OAuth runner", status: "active" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: agent.id, status: "running" }).returning();
      const entered = deferred<void>(); const release = deferred<Response>();
      io.userHandler = async () => { entered.resolve(); return release.promise; };
      const beforeDispatch = vi.fn(async () => undefined);
      const observed = fixture.service.executeGitHubOAuthTool({ companyId: fixture.companyId, connectionId: saved.id,
        catalogEntryId: entry.id, toolName: "github_create_issue", parameters: { owner: USER.login, repo: "synthetic-repo", title: "Synthetic issue" },
        actor: { actorType: "agent", actorId: agent.id }, runContext: { runId: run.id, issueId: null }, beforeDispatch,
      }).catch((error) => error);
      await waitForHold(entered.promise, observed);
      if (change === "run-cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      else await db.update(agents).set({ status: change }).where(eq(agents.id, agent.id));
      release.resolve(json(USER)); expect(await observed).toMatchObject({ status: 403 });
      expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(writeCalls()).toHaveLength(0);
      const [afterRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(afterRun.status).toBe(change === "run-cancelled" ? "cancelled" : "running");
      await expectNoAgentEffects(fixture.companyId, [run.id]);
    }
  });

  it("honors manual redirect refusal in the real guarded service transport", async () => {
    const fixture = await seed(); const saved = await active(fixture); const before = io.calls.length;
    io.userHandler = async () => new Response(null, { status: 302, headers: { location: "https://unapproved.fixture.test/user" } });
    await expect(fixture.service.checkHealth(saved.id, fixture.actor)).rejects.toMatchObject({ status: 502 });
    expect(io.calls.slice(before)).toHaveLength(1);
    expect(io.calls.every((call) => !call.url.includes("unapproved.fixture.test"))).toBe(true);
    expect(writeCalls()).toHaveLength(0); await expectNoAgentEffects(fixture.companyId);
  });
});
