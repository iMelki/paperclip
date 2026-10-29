import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolConnectionSnapshotColumns } from "../services/tool-connection-snapshot.js";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

vi.mock("node:dns/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: vi.fn(async () => [{ address: "140.82.113.6", family: 4 }]),
}));
const callback = "https://paperclip.fixture.test:5113/api/tools/oauth/callback";
const user = { id: 42, login: "synthetic-operator", type: "User" };
const page = { ownerType: "user" as const, owner: user.login, number: 12, after: null, first: 50 };
const data = { user: { projectV2: { id: "PVT_12", title: "Synthetic board",
  url: `https://github.com/users/${user.login}/projects/12`, updatedAt: "2026-10-13T00:00:00Z",
  items: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let db: ReturnType<typeof createDb>;
let fixture: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
let pageHandler: (() => Promise<Response>) | null = null;
const calls: Array<{ url: string; method: string }> = [];
async function syntheticFetch(input: string | URL | Request, init: RequestInit = {}) {
  const url = String(input), method = init.method ?? "GET";
  calls.push({ url, method });
  if (url === "https://github.com/login/oauth/access_token") return Response.json({
    access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 28800, token_type: "bearer", scope: "repo,project",
  });
  if (url === "https://api.github.com/user") return Response.json(user, { headers: { "X-OAuth-Scopes": "repo,project" } });
  if (url === "https://api.github.com/graphql" && method === "POST") {
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body)).query).not.toContain("mutation");
    return pageHandler ? pageHandler() : Response.json({ data });
  }
  throw new Error("Unexpected synthetic fixture endpoint; provider network is forbidden");
}
async function seed(options?: { updatedAtExact?: string }) {
  const companyId = randomUUID(), actor = { actorType: "user" as const, actorId: `synthetic-${randomUUID()}`, sessionId: randomUUID() };
  await db.insert(companies).values({ id: companyId, name: "Synthetic page-read company", issuePrefix: `GP${randomUUID().slice(0, 6).toUpperCase()}` });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actor.actorId,
    status: "active", membershipRole: "operator" });
  const secret = await secretService(db).create(companyId, { name: "Synthetic OAuth client", provider: "local_encrypted",
    value: "synthetic-client-secret" }, { userId: actor.actorId });
  const service = toolAccessService(db);
  const { connectionId } = await service.connectGalleryApp(companyId, { galleryKey: "github", methodKey: "rest-oauth",
    credentialValues: { "credentials.clientId": "synthetic-public-client" },
    credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.client_secret", versionSelector: "latest", required: true }],
    configValues: { expectedGitHubLogin: user.login } }, actor);
  let initialTimestamp: { updatedAt: Date; updatedAtExact: string } | null = null;
  if (options?.updatedAtExact) {
    await db.update(toolConnections).set({ updatedAt: sql`${options.updatedAtExact}::timestamptz` })
      .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)));
    const [observed] = await db.select(toolConnectionSnapshotColumns).from(toolConnections)
      .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)));
    initialTimestamp = { updatedAt: observed.updatedAt, updatedAtExact: observed.updatedAtExact };
  }
  const started = await service.startOAuth(companyId, connectionId, { redirectUri: callback, actor });
  await service.completeOAuthCallback({ state: new URL(started.authorizationUrl).searchParams.get("state")!,
    code: "synthetic-code", redirectUri: callback, actor });
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
  return { companyId, connectionId, connection, actor, service, initialTimestamp };
}
function read(setup: Awaited<ReturnType<typeof seed>>) {
  return setup.service.readVerifiedGitHubProjectPage({ companyId: setup.companyId, connectionId: setup.connectionId,
    actor: setup.actor, page, expectedAccountId: user.id, expectedLogin: user.login });
}
describe("native operator-only OAuth Project page authority", () => {
  beforeAll(async () => { fixture = await startBoardImportFixtureDatabase(); db = createDb(fixture.connectionString); }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await fixture?.cleanup(); } }, 30_000);
  beforeEach(() => {
    pageHandler = null; calls.length = 0;
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", callback.replace("/api/tools/oauth/callback", ""));
    vi.stubGlobal("fetch", vi.fn(syntheticFetch));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("returns only fixed board data/account facts/revision, never bearer or secret refs", async () => {
    const setup = await seed(), result = await read(setup);
    expect(result.page).toEqual(data); expect(result.account).toEqual({ accountId: user.id, login: user.login });
    expect(result.authorizationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-access");
    expect(result).not.toHaveProperty("headers"); expect(result).not.toHaveProperty("credentialSecretRefs");
  });
  it("starts OAuth with an unchanged six-digit native instant despite Date precision loss", async () => {
    const instant = "2026-10-13T01:02:03.123456Z";
    const setup = await seed({ updatedAtExact: instant });
    expect(setup.initialTimestamp?.updatedAtExact).toBe(instant);
    expect(setup.initialTimestamp?.updatedAt.toISOString()).toBe("2026-10-13T01:02:03.123Z");
    expect((await read(setup)).page).toEqual(data);
  });
  it("refuses a delayed page after a timestamp-only one-microsecond change", async () => {
    const setup = await seed();
    await db.update(toolConnections).set({ updatedAt: sql`${"2026-10-13T01:02:03.123456Z"}::timestamptz` })
      .where(and(eq(toolConnections.id, setup.connectionId), eq(toolConnections.companyId, setup.companyId)));
    const entered = deferred<void>(), released = deferred<Response>();
    pageHandler = async () => { entered.resolve(); return released.promise; };
    const pending = read(setup).then(value => ({ value, error: null as unknown }),
      error => ({ value: null, error }));
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected precise page hold was not reached"); })]);
      await db.update(toolConnections).set({ updatedAt: sql`${"2026-10-13T01:02:03.123457Z"}::timestamptz` })
        .where(and(eq(toolConnections.id, setup.connectionId), eq(toolConnections.companyId, setup.companyId)));
      released.resolve(Response.json({ data }));
      const outcome = await pending;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("authorization changed during board read");
      expect(calls.filter(call => call.url.endsWith("/graphql"))).toHaveLength(1);
    } finally { released.resolve(Response.json({ data })); await pending; }
  });
  it("restores successful page read when the exact microsecond observation stays unchanged", async () => {
    const setup = await seed();
    await db.update(toolConnections).set({ updatedAt: sql`${"2026-10-13T01:02:03.123456Z"}::timestamptz` })
      .where(and(eq(toolConnections.id, setup.connectionId), eq(toolConnections.companyId, setup.companyId)));
    const [before] = await db.select(toolConnectionSnapshotColumns).from(toolConnections)
      .where(eq(toolConnections.id, setup.connectionId));
    calls.length = 0;
    const result = await read(setup);
    const [after] = await db.select(toolConnectionSnapshotColumns).from(toolConnections)
      .where(eq(toolConnections.id, setup.connectionId));
    expect(before.updatedAtExact).toBe("2026-10-13T01:02:03.123456Z");
    expect(after.updatedAtExact).toBe(before.updatedAtExact);
    expect(result.page).toEqual(data);
    expect(calls.filter(call => call.url.endsWith("/graphql"))).toHaveLength(1);
  });
  it.each(["delete", "same-time-config", "parent-disabled", "secret-rotate", "user-viewer"])
    ("refuses a delayed provider response after %s instead of returning an eligible page", async change => {
      const setup = await seed(), entered = deferred<void>(), released = deferred<Response>();
      pageHandler = async () => { entered.resolve(); return released.promise; };
      const pending = read(setup).then(value => ({ value, error: null as unknown }), error => ({ value: null, error }));
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected page hold was not reached"); })]);
      if (change === "delete") await db.delete(toolConnections).where(eq(toolConnections.id, setup.connectionId));
      if (change === "same-time-config") await db.update(toolConnections).set({ config: { ...setup.connection.config, label: "changed" } })
        .where(eq(toolConnections.id, setup.connectionId));
      if (change === "parent-disabled") await db.update(toolApplications).set({ status: "disabled" }).where(eq(toolApplications.id, setup.connection.applicationId));
      if (change === "secret-rotate") {
        const ref = setup.connection.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token")!;
        await secretService(db).rotate(ref.secretId, { value: "synthetic-rotated-access" }, { userId: setup.actor.actorId });
      }
      if (change === "user-viewer") await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
        eq(companyMemberships.companyId, setup.companyId), eq(companyMemberships.principalId, setup.actor.actorId)));
      released.resolve(Response.json({ data }));
      const outcome = await pending;
      expect(outcome.value).toBeNull(); expect(outcome.error).toBeInstanceOf(Error);
      expect(calls.filter(call => call.url.endsWith("/graphql"))).toHaveLength(1);
    });
  it("refuses disabled parent application and nonuser authority before reading credentials/provider", async () => {
    const setup = await seed(); calls.length = 0;
    await db.update(toolApplications).set({ status: "disabled" }).where(eq(toolApplications.id, setup.connection.applicationId));
    await expect(read(setup)).rejects.toThrow("application is not active");
    await expect(setup.service.readVerifiedGitHubProjectPage({ companyId: setup.companyId, connectionId: setup.connectionId,
      page, actor: { actorType: "agent", actorId: randomUUID() } })).rejects.toThrow("signed-in operator");
    expect(calls).toEqual([]);
  });
});
