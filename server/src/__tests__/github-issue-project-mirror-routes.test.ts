import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companyMemberships, companySecrets, createDb, externalObjectMentions, externalObjects, issues,
  pluginState, plugins, projects, toolApplications, toolConnections,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createGitHubOAuthProviderConfig } from "@paperclipai/shared/github-oauth";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { githubProjectAuthorizationDigest } from "../services/github-oauth-project-page.js";
import { GitHubOAuthTransportError } from "../services/github-oauth-transport.js";
import { HttpError } from "../errors.js";
import { GITHUB_PROJECT_IMPORTER_KEY, pluginGitHubProjectBoardService } from "../services/plugin-github-project-board.js";
import { recordNativeGitHubConsent } from "../services/native-github-consent-receipt.js";
import { toolConnectionSnapshotColumns } from "../services/tool-connection-snapshot.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess } from "./helpers/route-test-harness.js";
import { EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Only the GitHub network read is replaced. The routes, the access checks, the grant store,
// the consent receipts and the saved cards all run against a real PostgreSQL database.
const { pageReader } = vi.hoisted(() => ({ pageReader: vi.fn() }));
vi.mock("../services/tool-access.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/tool-access.js")>();
  return {
    ...actual,
    toolAccessService: (...args: Parameters<typeof actual.toolAccessService>) =>
      ({ ...actual.toolAccessService(...args), readVerifiedGitHubProjectPage: pageReader }),
  };
});

const ISSUE_NODE = "I_synthetic_target";
const BOUND = { id: "PVT_bound", number: 12 };
const OTHER = { id: "PVT_other", number: 13 };
const pluginId = randomUUID();
// What the stand-in for the GitHub read does for a board number: throw this error, or decide per call.
let failures: Map<number, Error | ((call: number) => Error | null)> = new Map();
const readCalls = new Map<number, number>();
const rateLimited = () => new GitHubOAuthTransportError("github_project_rate_limited", 429);
const serverError = () => new GitHubOAuthTransportError("github_project_read_failed", 503);
// The kinds of "no access" the real reader produces (see github-oauth-project-page.ts).
const lostAccess: Array<[string, () => Error]> = [
  ["a 401", () => new GitHubOAuthTransportError("github_project_read_failed", 401)],
  ["a 404", () => new GitHubOAuthTransportError("github_project_read_failed", 404)],
  ["a GraphQL NOT_FOUND", () => new GitHubOAuthTransportError("github_project_access_denied", 403)],
  ["a conflict (account or board changed)", () => new HttpError(409, "GitHub board or account identity changed")],
];
let duringRead: (() => Promise<void>) | null = null;

function manifest(): PaperclipPluginManifestV1 {
  return { id: GITHUB_PROJECT_IMPORTER_KEY, apiVersion: 1, version: "0.0.0", displayName: "Synthetic bridge",
    description: "Route tests", author: "Fixture", categories: ["connector"],
    capabilities: ["issues.read", "projects.read", "plugin.state.read", "plugin.state.write"], entrypoints: { worker: "./fixture.js" } };
}
function boardData(board: { id: string; number: number }) {
  return { user: { projectV2: { id: board.id, title: `Board ${board.number}`,
    url: `https://github.com/users/example/projects/${board.number}`, updatedAt: "2026-11-01T00:00:00Z",
    items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: `PVTI_${board.number}`, isArchived: false,
      content: { __typename: "Issue", id: ISSUE_NODE, number: 1, title: "Synthetic issue",
        url: "https://github.com/example/fixture/issues/1", state: "OPEN", repository: { nameWithOwner: "example/fixture" } },
      fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "ProjectV2ItemFieldTextValue",
        id: `V_${board.number}`, text: `value ${board.number}`, field: { id: `F_${board.number}`, name: "Status" } }] },
    }] } } } };
}

describeEmbeddedPostgres("GitHub Project mirror routes", () => {
  // The shared harness gives the cluster 20 s to start. A loaded Windows host needs longer.
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let database: ReturnType<typeof createDb> | null = null;
  const ctx = { get db() { return database!; } };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-project-mirror-routes-");
    database = createDb(tempDb.connectionString);
    await ctx.db.insert(plugins).values({ id: pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY, packageName: "@fixture/github",
      version: "0.0.0", status: "ready", manifestJson: manifest() });
    await instanceSettingsService(ctx.db).updateExperimental({ enableExternalObjects: true });
  }, Math.max(EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS, 120_000));

  afterAll(async () => {
    await database?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
  }, 60_000);

  beforeEach(() => {
    failures = new Map();
    readCalls.clear();
    duringRead = null;
    pageReader.mockReset().mockImplementation(async (input: { connectionId: string; page: { number: number } }) => {
      if (duringRead && input.page.number === OTHER.number) await duringRead();
      const call = (readCalls.get(input.page.number) ?? 0) + 1;
      readCalls.set(input.page.number, call);
      const rule = failures.get(input.page.number);
      const failure = typeof rule === "function" ? rule(call) : rule;
      if (failure) throw failure;
      const [connection] = await ctx.db.select(toolConnectionSnapshotColumns).from(toolConnections)
        .where(eq(toolConnections.id, input.connectionId));
      const [secret] = await ctx.db.select().from(companySecrets).where(eq(companySecrets.id, connection.credentialSecretRefs[0].secretId));
      const board = input.page.number === BOUND.number ? BOUND : OTHER;
      return { page: boardData(board), account: { accountId: 42, login: "example" },
        authorizationDigest: githubProjectAuthorizationDigest(connection, { secretId: secret.id, latestVersion: secret.latestVersion }) };
    });
  });

  async function member(companyId: string, role: "operator" | "viewer") {
    const userId = `user-${randomUUID()}`;
    await ctx.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: role, updatedAt: new Date() });
    await ensureHumanRoleDefaultGrants(ctx.db, { companyId, principalId: userId, membershipRole: role, grantedByUserId: null });
    return { userId, actor: { type: "board" as const, source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }], isInstanceAdmin: false } };
  }

  async function seed(options: { bind?: boolean } = {}) {
    const owner = await seedCompanyWithBoardAccess(ctx.db, "Mirror routes");
    const { companyId } = owner;
    const projectId = randomUUID(), issueId = randomUUID(), objectId = randomUUID(), applicationId = randomUUID();
    const connectionId = randomUUID(), secretId = randomUUID(), agentId = randomUUID();
    await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Synthetic project", status: "planned" });
    await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Synthetic task", status: "todo", priority: "medium" });
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Synthetic agent", status: "idle" });
    await ctx.db.insert(externalObjects).values({ id: objectId, companyId, providerKey: "github", objectType: "issue",
      externalId: "example/fixture#issues/1", sanitizedCanonicalUrl: "https://github.com/example/fixture/issues/1",
      canonicalIdentityHash: createHash("sha256").update(objectId).digest("hex"), liveness: "live",
      data: { nodeId: ISSUE_NODE, issueTitle: "Synthetic issue", state: "open" } });
    await ctx.db.insert(externalObjectMentions).values({ companyId, sourceIssueId: issueId, sourceKind: "description",
      objectId, providerKey: "github", objectType: "issue", confidence: "exact" });
    await ctx.db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "rest_api" });
    await ctx.db.insert(companySecrets).values({ id: secretId, companyId, key: "fixture-access", name: "Synthetic access",
      latestVersion: 1, provider: "local_encrypted" });
    const config = { sourceTemplateKey: "github", methodKey: "rest-oauth", serverUrl: "https://api.github.com",
      expectedGitHubLogin: "example", oauth: createGitHubOAuthProviderConfig("synthetic-client"),
      providerMetadata: { githubOAuth: { accountId: 42, login: "example", grantedScopes: ["repo", "project"],
        checkedAt: "2026-11-01T00:00:00Z" } } };
    await ctx.db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Synthetic native GitHub",
      uid: connectionId, transport: "rest_api", authKind: "oauth", enabled: true, status: "active", config, transportConfig: config,
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest", required: true }] });
    const other = await member(companyId, "operator");
    const viewer = await member(companyId, "viewer");
    const foreign = await seedCompanyWithBoardAccess(ctx.db, "Foreign");
    // Bind the Paperclip project to the first board, as the importer does.
    const board = pluginGitHubProjectBoardService(ctx.db, { pluginId, pluginKey: GITHUB_PROJECT_IMPORTER_KEY }, pageReader as never);
    if (options.bind !== false) {
      await board.bind({ companyId, actor: { type: "user", userId: owner.userId } } as never,
        { companyId, projectId, connectionId, boardUrl: `https://github.com/users/example/projects/${BOUND.number}` });
    }
    return { ...owner, projectId, issueId, objectId, connectionId, secretId, agentId, other, viewer, foreign };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function consent(seeded: Seeded, userId: string, stamp = new Date()) {
    const [connection] = await ctx.db.select(toolConnectionSnapshotColumns).from(toolConnections)
      .where(eq(toolConnections.id, seeded.connectionId));
    await recordNativeGitHubConsent(ctx.db as never, connection as never, userId,
      { accountId: 42, login: "example" }, seeded.secretId);
    await ctx.db.update(activityLog).set({ createdAt: stamp }).where(and(eq(activityLog.entityId, seeded.connectionId),
      eq(activityLog.actorId, userId)));
  }

  const call = (seeded: Seeded, actor: unknown, path: "github-project-mirror" | "github-project-access", body: Record<string, unknown>) =>
    request(routeApp(ctx.db, actor as never, issueRoutes)).post(`/api/issues/${seeded.issueId}/${path}`)
      .send({ objectId: seeded.objectId, ...body });
  const mirror = (seeded: Seeded, actor: unknown) => call(seeded, actor, "github-project-mirror", {});
  const access = (seeded: Seeded, actor: unknown, action: Record<string, unknown>) =>
    call(seeded, actor, "github-project-access", { action });
  const register = (seeded: Seeded, actor: unknown, board = OTHER) => access(seeded, actor, { op: "register",
    connectionId: seeded.connectionId, boardUrl: `https://github.com/users/example/projects/${board.number}` });
  const ids = (body: { mirror: { projects: Array<{ projectId: string }> } }) => body.mirror.projects.map(card => card.projectId).sort();

  it("refuses a viewer, a board key, an agent and another company's user on both routes", async () => {
    const seeded = await seed();
    const ok = await mirror(seeded, seeded.actor);
    expect(ok.status).toBe(200);
    expect(ids(ok.body)).toEqual([BOUND.id]);
    const boardKey = { ...seeded.actor, source: "board_key" };
    const agent = { type: "agent", agentId: seeded.agentId, companyId: seeded.companyId, keyId: randomUUID(), source: "agent_key" };
    for (const [name, actor] of [["viewer", seeded.viewer.actor], ["board key", boardKey], ["agent", agent],
      ["foreign user", seeded.foreign.actor]] as const) {
      for (const response of [await mirror(seeded, actor), await access(seeded, actor, { op: "list" }),
        await access(seeded, actor, { op: "saved" })]) {
        expect([403, 404], `${name}: ${response.status}`).toContain(response.status);
      }
    }
  });

  it("keeps the bound board visible after a register and after a revoke", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId);
    const registered = await register(seeded, seeded.actor);
    expect(registered.status).toBe(200);
    const withBoth = await mirror(seeded, seeded.actor);
    expect(withBoth.status).toBe(200);
    expect(ids(withBoth.body)).toEqual([BOUND.id, OTHER.id]);
    expect(withBoth.body.accessRequired).toBeFalsy();
    const saved = await access(seeded, seeded.actor, { op: "saved" });
    expect(saved.body.grants).toHaveLength(1);
    const revoked = await access(seeded, seeded.actor, { op: "revoke", projectId: OTHER.id, expectedGrantId: saved.body.grants[0].grantId });
    expect(revoked.status).toBe(200);
    const afterRevoke = await mirror(seeded, seeded.actor);
    expect(afterRevoke.status).toBe(200);
    expect(ids(afterRevoke.body)).toEqual([BOUND.id]);
    expect((await access(seeded, seeded.actor, { op: "saved" })).body.grants).toEqual([]);
  });

  it("does not show or revoke one user's grant to another user of the same company", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId);
    expect((await register(seeded, seeded.actor)).status).toBe(200);
    const grantId = (await access(seeded, seeded.actor, { op: "saved" })).body.grants[0].grantId;
    const savedByOther = await access(seeded, seeded.other.actor, { op: "saved" });
    expect(savedByOther.status).toBe(200);
    expect(savedByOther.body.grants).toEqual([]);
    const mirrorForOther = await mirror(seeded, seeded.other.actor);
    expect(mirrorForOther.status).toBe(200);
    expect(ids(mirrorForOther.body)).not.toContain(OTHER.id);
    const revoke = await access(seeded, seeded.other.actor, { op: "revoke", projectId: OTHER.id, expectedGrantId: grantId });
    expect(revoke.status).toBe(409);
    expect((await access(seeded, seeded.actor, { op: "saved" })).body.grants).toHaveLength(1);
  });

  it("refuses a register when the latest consent on the connection belongs to someone else", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.other.userId);
    const refused = await register(seeded, seeded.actor);
    expect([403, 409]).toContain(refused.status);
    expect((await access(seeded, seeded.actor, { op: "saved" })).body.grants).toEqual([]);
    expect((await access(seeded, seeded.actor, { op: "list" })).body.connections).toEqual([]);
  });

  it("is not blocked by a forged newer receipt row from another writer", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId, new Date(Date.now() - 60_000));
    const [real] = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, seeded.connectionId));
    await ctx.db.insert(activityLog).values({ companyId: seeded.companyId, actorType: "user", actorId: seeded.userId,
      entityType: "tool_connection", entityId: seeded.connectionId, action: real.action, details: real.details,
      responsibleUserId: null, createdAt: new Date() });
    expect((await register(seeded, seeded.actor)).status).toBe(200);
  });

  it("writes the saved card under the key the reader uses, and returns it when the read is unavailable", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId);
    expect((await register(seeded, seeded.actor)).status).toBe(200);
    expect((await mirror(seeded, seeded.actor)).status).toBe(200);
    const saved = (await ctx.db.select().from(pluginState).where(eq(pluginState.pluginId, pluginId)))
      .filter(row => row.stateKey.startsWith("issue-mirror-v2:"));
    expect(saved.length).toBeGreaterThanOrEqual(2);
    failures.set(OTHER.number, serverError());
    const degraded = await mirror(seeded, seeded.actor);
    expect(degraded.status).toBe(200);
    expect(ids(degraded.body)).toEqual([BOUND.id, OTHER.id]);
    expect(degraded.body.accessRequired).toBeFalsy();
    expect(degraded.body.boardReadStates).toContainEqual({ projectId: OTHER.id, state: "unavailable" });
    expect(degraded.body.mirror.projects.find((card: { projectId: string }) => card.projectId === OTHER.id).fields[0].value).toBe("value 13");
  });

  it("keeps the saved bound card when GitHub is rate limited or down", async () => {
    const seeded = await seed();
    expect((await mirror(seeded, seeded.actor)).status).toBe(200);
    failures.set(BOUND.number, rateLimited());
    const degraded = await mirror(seeded, seeded.actor);
    expect(degraded.status).toBe(200);
    expect(degraded.body.state).toBe("unavailable");
    expect(ids(degraded.body)).toEqual([BOUND.id]);
    expect(degraded.body.accessRequired).toBeFalsy();
  });

  describe("lost access on GitHub", () => {
    it.each(lostAccess)("drops a registered board's saved card and asks for access after %s", async (_name, build) => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      expect((await register(seeded, seeded.actor)).status).toBe(200);
      expect(ids((await mirror(seeded, seeded.actor)).body)).toEqual([BOUND.id, OTHER.id]);
      failures.set(OTHER.number, build());
      const lost = await mirror(seeded, seeded.actor);
      expect(lost.status).toBe(200);
      expect(ids(lost.body)).toEqual([BOUND.id]);
      expect(lost.body.accessRequired).toBe(true);
      expect(lost.body.state).toBe("partial");
    });

    it.each(lostAccess)("returns the denied state for the bound board, with no card, after %s", async (_name, build) => {
      const seeded = await seed();
      expect((await mirror(seeded, seeded.actor)).status).toBe(200);
      failures.set(BOUND.number, build());
      const lost = await mirror(seeded, seeded.actor);
      expect(lost.status).toBe(200);
      expect(lost.body.state).toBe("denied");
      expect(lost.body.mirror.projects).toEqual([]);
    });

    it.each(lostAccess)("keeps the registered boards that read fine when the bound board lost access (%s)", async (_name, build) => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      expect((await register(seeded, seeded.actor)).status).toBe(200);
      expect((await mirror(seeded, seeded.actor)).status).toBe(200);
      failures.set(BOUND.number, build());
      const mixed = await mirror(seeded, seeded.actor);
      expect(mixed.status).toBe(200);
      expect(ids(mixed.body)).toEqual([OTHER.id]);
      expect(mixed.body.state).toBe("partial");
      expect(mixed.body.accessRequired).toBe(true);
    });
  });

  it("does not ask for access when the project has no bound board and the user has a registered board", async () => {
    const seeded = await seed({ bind: false });
    await consent(seeded, seeded.userId);
    expect((await register(seeded, seeded.actor)).status).toBe(200);
    const result = await mirror(seeded, seeded.actor);
    expect(result.status).toBe(200);
    expect(ids(result.body)).toEqual([OTHER.id]);
    expect(result.body.accessRequired).toBeFalsy();
    expect(result.body.state).toBe("fresh");
  });

  it("shows a mixed result as partial, with the saved bound card and the fresh registered card", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId);
    expect((await register(seeded, seeded.actor)).status).toBe(200);
    expect((await mirror(seeded, seeded.actor)).status).toBe(200);
    failures.set(BOUND.number, rateLimited());
    const mixed = await mirror(seeded, seeded.actor);
    expect(mixed.status).toBe(200);
    expect(ids(mixed.body)).toEqual([BOUND.id, OTHER.id]);
    expect(mixed.body.state).toBe("partial");
    expect(mixed.body.accessRequired).toBeFalsy();
    expect(mixed.body.boardReadStates).toContainEqual({ projectId: BOUND.id, state: "unavailable" });
    expect(mixed.body.boardReadStates).toContainEqual({ projectId: OTHER.id, state: "fresh" });
  });

  it("prefers the fresh registered card when the same board is bound and registered", async () => {
    const seeded = await seed();
    await consent(seeded, seeded.userId);
    expect((await register(seeded, seeded.actor, BOUND)).status).toBe(200);
    expect((await mirror(seeded, seeded.actor)).status).toBe(200);
    readCalls.clear();
    // The registered read is the first read of the board and the bound read is the second.
    failures.set(BOUND.number, call => (call === 2 ? serverError() : null));
    const merged = await mirror(seeded, seeded.actor);
    expect(merged.status).toBe(200);
    expect(ids(merged.body)).toEqual([BOUND.id]);
    expect(merged.body.state).toBe("fresh");
    expect(merged.body.boardReadStates).toEqual([{ projectId: BOUND.id, state: "fresh" }]);
  });

  describe("authorization that changes while GitHub is being read", () => {
    const grantRows = (companyId: string) => ctx.db.select().from(pluginState).where(and(eq(pluginState.pluginId, pluginId),
      eq(pluginState.scopeId, companyId), like(pluginState.stateKey, "issue-read-grant-v1:%")));

    it("refuses a register and writes no grant when the caller loses membership during the read", async () => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      duringRead = async () => {
        await ctx.db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, seeded.companyId),
          eq(companyMemberships.principalId, seeded.userId)));
      };
      const refused = await register(seeded, seeded.actor);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await grantRows(seeded.companyId)).toEqual([]);
    });

    it("refuses a register and writes no grant when the caller is made a viewer during the read", async () => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      duringRead = async () => {
        await ctx.db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
          eq(companyMemberships.companyId, seeded.companyId), eq(companyMemberships.principalId, seeded.userId)));
      };
      const refused = await register(seeded, seeded.actor);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await grantRows(seeded.companyId)).toEqual([]);
    });

    it("refuses a register and writes no grant when the project is archived during the read", async () => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      duringRead = async () => {
        await ctx.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, seeded.projectId));
      };
      const refused = await register(seeded, seeded.actor);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await grantRows(seeded.companyId)).toEqual([]);
    });

    it("refuses a register and writes no grant when the plugin is disabled during the read", async () => {
      const seeded = await seed();
      await consent(seeded, seeded.userId);
      duringRead = async () => {
        await ctx.db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
      };
      try {
        const refused = await register(seeded, seeded.actor);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(await grantRows(seeded.companyId)).toEqual([]);
      } finally {
        await ctx.db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
      }
    });
  });
});
