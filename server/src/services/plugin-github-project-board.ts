import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { updateGitHubIssueMirror, type GitHubIssueIdentity, type GitHubIssueMirror, type GitHubMirrorRead, type GitHubProjectObservation }
  from "@paperclipai/shared/github-issue-project-mirror";
import { verifyNativeGitHubConsent } from "./native-github-consent-receipt.js";
import { GitHubBoardRegistrationRefused, registerGitHubBoardRead, revokeGitHubBoardRead,
  type GitHubBoardReadRegistration, type GitHubBoardReadCatalog } from "./github-board-read-registration.js";
import { githubBoardReadGrantSchema, githubIssueBoardReadGrantKey, githubIssueBoardReadGrantStore } from "./github-issue-board-read-grant-store.js";
import { readGitHubIssueBoards, type GitHubMirrorReadScope } from "./github-issue-board-read-grants.js";
import { readGitHubIssueProjectMirrorPage } from "./github-issue-project-mirror-page.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyMemberships, companySecrets, plugins, pluginState, projects, toolApplications, toolConnections } from "@paperclipai/db";
import { z } from "zod";
import { HttpError, conflict, forbidden, unprocessable } from "../errors.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { toolConnectionSnapshotColumns } from "./tool-connection-snapshot.js";
import { GitHubOAuthTransportError, isNativeGitHubOAuthConnection } from "./github-oauth-transport.js";
import { githubOAuthRequiredScopes, githubScopesExceed, githubScopesSatisfy, githubStoredPrivateRepoAccessOptIn } from "@paperclipai/shared/github-oauth";
import { checkedGitHubProjectPage, parseGitHubProjectBoardUrl, validateGitHubProjectPageInput,
  githubProjectAuthorizationDigest, githubProjectConsentDigest,
  type GitHubProjectPageInput } from "./github-oauth-project-page.js";
import { validateBoardImportContext, validateBoardImportIntent, type BoardImportHostContext } from "./plugin-imported-issues-contract.js";
import { advanceGitHubProjectAttestation, assertGitHubProjectAttestedIntent, pendingGitHubProjectAttestation,
  type GitHubProjectAttestation } from "./github-project-board-attestation.js";
import { scheduleGrantSchema, parseScheduleGrantInput, type GitHubProjectScheduleGrant }
  from "./github-project-schedule-grant-contract.js";
import { matchesNativeScheduleGrantSnapshot } from "./plugin-github-project-schedule-grants.js";
import type { ScheduledBoardAccess, ScheduledBoardTarget, ScheduledGitHubPageInput, ScheduledGitHubPageReader,
  VerifiedScheduledBoard } from "./github-project-scheduled-contract.js";

export const GITHUB_PROJECT_BINDING_NAMESPACE = "paperclip.host.github-project-board/v1";
export const GITHUB_PROJECT_IMPORTER_KEY = "paperclip-github-plugin";
const scopeSchema = z.object({ companyId: z.string().uuid(), projectId: z.string().uuid() }).strict();
const bindSchema = scopeSchema.extend({ boardUrl: z.string().max(2048), connectionId: z.string().uuid() }).strict();
const readSchema = scopeSchema.extend({ page: z.unknown() }).strict();
const rpcSchema = z.discriminatedUnion("op", [
  scopeSchema.extend({ op: z.literal("listProjectConnections") }),
  scopeSchema.extend({ op: z.literal("readProjectBinding") }),
  bindSchema.extend({ op: z.literal("bindProjectBoard") }),
  readSchema.extend({ op: z.literal("readProjectPage") }),
]);
export function validateGitHubProjectBoardRequest(value: unknown) {
  return parse(rpcSchema, value);
}
const bindingSchema = bindSchema.extend({
  version: z.literal(1), boardId: z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/),
  accountId: z.number().int().positive().safe(), login: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  boundByUserId: z.string().min(1).max(256), boundAt: z.string().datetime(),
}).strict();
export type GitHubProjectBinding = z.infer<typeof bindingSchema>;
type ReadPage = (input: {
  companyId: string; connectionId: string; page: GitHubProjectPageInput;
  expectedAccountId?: number; expectedLogin?: string;
  actor: { actorType: "user"; actorId: string };
}) => Promise<{ page: unknown; account: { accountId: number; login: string }; authorizationDigest: string }>;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw unprocessable("Invalid bounded GitHub board binding request");
  return result.data;
};

/**
 * A GitHub read failure that says nothing about access, so the saved card may still be shown:
 * a rate limit (429), a GitHub server error (5xx), a timeout, or a response that is too large,
 * not JSON or incomplete. Every other failure (401, 403, 404, 422, a GraphQL NOT_FOUND or FORBIDDEN,
 * an invalid bearer) counts as lost access. This is an allow-list, so a new failure kind is denied.
 */
export function isTransientGitHubReadError(error: unknown) {
  if (!(error instanceof GitHubOAuthTransportError)) return false;
  return error.status === 429 || error.status >= 500;
}

/** The host, not worker-writable state or secret refs, owns the OAuth authority for each destination. */
export function pluginGitHubProjectBoardService(
  db: Db, identity: { pluginId: string; pluginKey: string }, readPage: ReadPage,
  scheduledAccess?: ScheduledBoardAccess,
  scheduledReadPage?: (input: ScheduledGitHubPageInput) => ReturnType<ScheduledGitHubPageReader>,
) {
  const key = (projectId: string) => `project:${projectId}`;
  const store = (executor: Db) => pluginStateStore(executor);
  const assertTransactionDeadline = (startedAt: number) => {
    if (Date.now() - startedAt > 20_000) throw conflict("Native GitHub board transaction exceeded its bounded deadline");
  };
  // One ordering for observation, binding and import: plugin -> member -> project -> binding advisory -> app -> connection -> secret -> host state.
  const lockBinding = (executor: Db, companyId: string, projectId: string) => executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`github-project-binding:${companyId}:${projectId}`}, 0))`);
  async function authorize(executor: Db, context: BoardImportHostContext, input: unknown) {
    const userId = validateBoardImportContext(context)!;
    const scope = parse(scopeSchema, input);
    if (scope.companyId !== context.companyId) {
      throw forbidden("Matching company and native GitHub importer required");
    }
    return authorizeSubject(executor, scope, userId);
  }
  async function authorizeSubject(executor: Db, scope: z.infer<typeof scopeSchema>, userId: string, readyOnly = false) {
    if (identity.pluginKey !== GITHUB_PROJECT_IMPORTER_KEY || !userId || userId.trim() !== userId) {
      throw forbidden("Matching company and native GitHub importer required");
    }
    const [plugin] = await executor.select({ key: plugins.pluginKey, status: plugins.status }).from(plugins)
      .where(eq(plugins.id, identity.pluginId)).for("share").limit(1);
    const [member] = await executor.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, scope.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    )).for("share").limit(1);
    const [project] = await executor.select({ id: projects.id }).from(projects).where(and(
      eq(projects.companyId, scope.companyId), eq(projects.id, scope.projectId), isNull(projects.archivedAt),
    )).for("share").limit(1);
    if (!plugin || plugin.key !== identity.pluginKey || !(readyOnly ? ["ready"] : ["ready", "installed"]).includes(plugin.status)
      || !member || member.role === "viewer" || !project) throw forbidden("Active operator and existing company project required");
    return { ...scope, userId };
  }
  async function nativeConnection(executor: Db, companyId: string, connectionId: string) {
    const [candidate] = await executor.select().from(toolConnections).where(and(
      eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId),
    )).limit(1);
    const [application] = candidate ? await executor.select({ id: toolApplications.id }).from(toolApplications).where(and(
      eq(toolApplications.id, candidate.applicationId), eq(toolApplications.companyId, companyId),
      eq(toolApplications.status, "active"), isNull(toolApplications.archivedAt),
    )).for("share").limit(1) : [];
    const [connection] = candidate ? await executor.select(toolConnectionSnapshotColumns).from(toolConnections).where(and(
      eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId),
      eq(toolConnections.applicationId, candidate.applicationId),
    )).for("share").limit(1) : [];
    const facts = record(record(connection?.config.providerMetadata).githubOAuth), grantedScopes = facts.grantedScopes;
    if (!connection || !connection.enabled || connection.status !== "active" || !isNativeGitHubOAuthConnection(connection)
      || !application
      || typeof facts.accountId !== "number" || !Number.isSafeInteger(facts.accountId) || facts.accountId < 1
      || typeof facts.login !== "string" || typeof connection.config.expectedGitHubLogin !== "string"
      || facts.login.toLowerCase() !== connection.config.expectedGitHubLogin.toLowerCase()
      || !Array.isArray(grantedScopes)
      || !githubScopesSatisfy(grantedScopes, githubOAuthRequiredScopes(githubStoredPrivateRepoAccessOptIn(connection.config)))
      || githubScopesExceed(grantedScopes, githubStoredPrivateRepoAccessOptIn(connection.config))) {
      throw forbidden("Selected native GitHub OAuth connection is not verified and active");
    }
    const accessRefs = connection.credentialSecretRefs.filter(ref => ref.configPath === "oauth.access_token");
    if (accessRefs.length !== 1) throw forbidden("Native GitHub OAuth access credential metadata is missing or ambiguous");
    const [secret] = await executor.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion }).from(companySecrets)
      .where(and(eq(companySecrets.id, accessRefs[0].secretId), eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt))).for("share").limit(1);
    if (!secret) throw forbidden("Native GitHub OAuth access credential is not active in this company");
    return { connection, facts: { accountId: facts.accountId, login: facts.login },
      credentialRevision: { secretId: secret.id, latestVersion: secret.latestVersion },
      consentDigest: githubProjectConsentDigest(connection, { secretId: secret.id, latestVersion: secret.latestVersion }),
      authorizationDigest: githubProjectAuthorizationDigest(connection, { secretId: secret.id, latestVersion: secret.latestVersion }) };
  }
  async function readProtectedState(executor: Db, companyId: string, stateKey: string, locked = false) {
    const query = executor.select({ value: pluginState.valueJson }).from(pluginState).where(and(
      eq(pluginState.pluginId, identity.pluginId), eq(pluginState.scopeKind, "company"), eq(pluginState.scopeId, companyId),
      eq(pluginState.namespace, GITHUB_PROJECT_BINDING_NAMESPACE), eq(pluginState.stateKey, stateKey),
    )).limit(1);
    const [row] = locked ? await query.for("share") : await query;
    return row?.value ?? null;
  }
  async function retained(executor: Db, companyId: string, projectId: string, locked = false) {
    const value = await readProtectedState(executor, companyId, key(projectId), locked);
    if (value === null) return null;
    const binding = parse(bindingSchema, value);
    if (binding.companyId !== companyId || binding.projectId !== projectId
      || parseGitHubProjectBoardUrl(binding.boardUrl).url !== binding.boardUrl) {
      throw conflict("Retained native board binding scope changed");
    }
    return binding;
  }
  async function verifiedBinding(executor: Db, context: BoardImportHostContext, input: unknown, standingConsent = false) {
    const scope = await authorize(executor, context, input);
    return verifiedSubjectBinding(executor, scope, standingConsent);
  }
  async function verifiedSubjectBinding(executor: Db, scope: z.infer<typeof scopeSchema> & { userId: string },
    standingConsent = false) {
    await lockBinding(executor, scope.companyId, scope.projectId);
    const binding = await retained(executor, scope.companyId, scope.projectId);
    if (!binding) throw forbidden("Select and bind a native GitHub OAuth connection first");
    const current = await nativeConnection(executor, scope.companyId, binding.connectionId);
    if (!isDeepStrictEqual(await retained(executor, scope.companyId, scope.projectId, true), binding)) {
      throw conflict("Native board binding changed during authorization");
    }
    if (current.facts.accountId !== binding.accountId || current.facts.login.toLowerCase() !== binding.login.toLowerCase()) {
      throw conflict("GitHub account changed after board binding");
    }
    return { ...scope, binding,
      authorizationDigest: standingConsent ? current.consentDigest : current.authorizationDigest };
  }
  function requireScheduledAccess() {
    if (!scheduledAccess) throw forbidden("Native scheduled board authority is not configured");
    return scheduledAccess;
  }
  function assertScheduledTarget(target: ScheduledBoardTarget) {
    const scope = parse(scopeSchema, { companyId: target.companyId, projectId: target.projectId });
    if (target.pluginId !== identity.pluginId || identity.pluginKey !== GITHUB_PROJECT_IMPORTER_KEY) {
      throw forbidden("Scheduled native board plugin differs");
    }
    return scope;
  }
  function assertScheduledSnapshot(current: Readonly<VerifiedScheduledBoard>, expected: Readonly<VerifiedScheduledBoard>) {
    if (!isDeepStrictEqual(current.binding, expected.binding) || current.authorizationDigest !== expected.authorizationDigest
      || !isDeepStrictEqual(current.owner, expected.owner) || current.leaseRevision !== expected.leaseRevision) {
      throw conflict("Native scheduled board authorization changed during observation");
    }
  }
  async function validateScheduledPage(authority: unknown, target: ScheduledBoardTarget) {
    const access = requireScheduledAccess();
    access.inspect(authority, target);
    return db.transaction(async tx => {
      const executor = tx as unknown as Db, startedAt = Date.now();
      await executor.execute(sql`set local statement_timeout = '10000ms'`);
      await executor.execute(sql`set local lock_timeout = '5000ms'`);
      const current = await access.validate(executor, authority, target, "read-page");
      assertTransactionDeadline(startedAt);
      return current;
    });
  }
  async function recordScheduledObservation(authority: unknown, target: ScheduledBoardTarget,
    expected: Readonly<VerifiedScheduledBoard>, page: GitHubProjectPageInput, data?: unknown) {
    return db.transaction(async tx => {
      const executor = tx as unknown as Db, startedAt = Date.now(), access = requireScheduledAccess();
      await executor.execute(sql`set local statement_timeout = '10000ms'`);
      await executor.execute(sql`set local lock_timeout = '5000ms'`);
      const current = await access.validate(executor, authority, target, "record-page");
      assertScheduledSnapshot(current, expected);
      const stateKey = `attestation:${target.projectId}`;
      const previous = data === undefined ? pendingGitHubProjectAttestation(current.binding, current.authorizationDigest)
        : await readProtectedState(executor, target.companyId, stateKey, true) as GitHubProjectAttestation;
      const value = data === undefined ? previous
        : advanceGitHubProjectAttestation(previous, current.binding, page, data, current.authorizationDigest);
      assertTransactionDeadline(startedAt);
      await store(executor).set(identity.pluginId, { scopeKind: "company", scopeId: target.companyId,
        namespace: GITHUB_PROJECT_BINDING_NAMESPACE, stateKey, value });
      if (!isDeepStrictEqual(await readProtectedState(executor, target.companyId, stateKey), value)) {
        throw conflict("Native scheduled GitHub board observation readback failed");
      }
      assertScheduledSnapshot(await access.validate(executor, authority, target, "record-page"), expected);
      assertTransactionDeadline(startedAt);
    });
  }
  async function fetchBound(scope: { companyId: string; userId: string; authorizationDigest: string;
    binding: Pick<GitHubProjectBinding, "boardUrl" | "boardId" | "connectionId" | "accountId" | "login"> },
  page: GitHubProjectPageInput) {
    const reference = parseGitHubProjectBoardUrl(scope.binding.boardUrl);
    if (page.ownerType !== reference.ownerType || page.owner !== reference.owner || page.number !== reference.number) {
      throw forbidden("Requested board differs from native destination binding");
    }
    const result = await readPage({ companyId: scope.companyId, connectionId: scope.binding.connectionId, page,
      expectedAccountId: scope.binding.accountId, expectedLogin: scope.binding.login,
      actor: { actorType: "user", actorId: scope.userId } });
    const checked = checkedGitHubProjectPage(result.page, page);
    if (checked.board.id !== scope.binding.boardId || result.account.accountId !== scope.binding.accountId
      || result.account.login.toLowerCase() !== scope.binding.login.toLowerCase()
      || result.authorizationDigest !== scope.authorizationDigest) {
      throw conflict("GitHub board or account identity changed");
    }
    return checked;
  }
  async function recordObservation(context: BoardImportHostContext, scope: Awaited<ReturnType<typeof verifiedBinding>>,
    page: GitHubProjectPageInput, data?: unknown) {
    return db.transaction(async tx => {
      const executor = tx as unknown as Db;
      const startedAt = Date.now();
      await executor.execute(sql`set local statement_timeout = '10000ms'`);
      await executor.execute(sql`set local lock_timeout = '5000ms'`);
      const current = await verifiedBinding(executor, context, { companyId: scope.companyId, projectId: scope.projectId });
      if (!isDeepStrictEqual(current.binding, scope.binding) || current.authorizationDigest !== scope.authorizationDigest) {
        throw conflict("Native board binding or authorization changed during observation");
      }
      const stateKey = `attestation:${scope.projectId}`;
      const previous = data === undefined ? pendingGitHubProjectAttestation(scope.binding, scope.authorizationDigest)
        : await store(executor).get(identity.pluginId, "company", stateKey,
          { scopeId: scope.companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE }) as GitHubProjectAttestation;
      const value = data === undefined ? previous
        : advanceGitHubProjectAttestation(previous, scope.binding, page, data, scope.authorizationDigest);
      assertTransactionDeadline(startedAt);
      await store(executor).set(identity.pluginId, { scopeKind: "company", scopeId: scope.companyId,
        namespace: GITHUB_PROJECT_BINDING_NAMESPACE, stateKey, value });
      if (!isDeepStrictEqual(await readProtectedState(executor, scope.companyId, stateKey), value)) {
        throw conflict("Native GitHub board observation readback failed");
      }
      assertTransactionDeadline(startedAt);
    });
  }
  async function readMirrorGrantSnapshot(context: BoardImportHostContext,
      input: { scope: GitHubMirrorReadScope; issue: GitHubIssueIdentity; projectIds: readonly string[];
        assertCurrentIssue: (executor: Db) => Promise<boolean> }) {
      const { scope, issue, projectIds } = input;
      const grants = githubIssueBoardReadGrantStore(db,
        { pluginId: identity.pluginId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE }, {
          async canReadIssue(executor) {
            const verified = await authorize(executor, context,
              { companyId: scope.companyId, projectId: scope.paperclipProjectId });
            return verified.userId === scope.userId && await input.assertCurrentIssue(executor);
          },
          async verifyRegisteredConnection(executor, requested, grant) {
            try {
              const current = await nativeConnection(executor, requested.companyId, grant.connectionId);
              return current.facts.accountId === grant.accountId
                && current.facts.login.toLowerCase() === grant.login.toLowerCase()
                && current.authorizationDigest === grant.authorizationRevision;
            } catch (error) {
              if (error instanceof HttpError && [401, 403, 404, 409].includes(error.status)) return false;
              throw error;
            }
          },
        });
      return await grants.finalAuthorization(scope, issue, projectIds);
  }

  /** One saved-card key for a registered board. The writer and the reader both use it. */
  const registeredMirrorKey = (scope: GitHubMirrorReadScope, grant: { projectId: string; connectionId: string;
    authorizationRevision: string; grantId: string }) => "issue-mirror-v2:" + createHash("sha256").update(JSON.stringify(
    [scope.companyId, scope.paperclipProjectId, scope.paperclipIssueId, scope.objectId, scope.userId,
      grant.projectId, grant.connectionId, grant.authorizationRevision, grant.grantId])).digest("hex");

  async function refreshRegisteredIssueMirrors(context: BoardImportHostContext,
    input: { scope: GitHubMirrorReadScope; issue: GitHubIssueIdentity;
      assertCurrentIssue: (executor: Db) => Promise<boolean> }): Promise<GitHubMirrorRead | null> {
    const { scope, issue } = input;
    const catalog = await db.transaction(async tx => {
      const executor = tx as unknown as Db;
      const actor = await authorize(executor, context, { companyId: scope.companyId, projectId: scope.paperclipProjectId });
      if (actor.userId !== scope.userId || !(await input.assertCurrentIssue(executor))) {
        throw forbidden("The linked GitHub issue is no longer readable");
      }
      const key = "issue-read-catalog-v1:" + createHash("sha256").update(JSON.stringify(
        [scope.companyId, scope.paperclipProjectId, scope.userId],
      )).digest("hex");
      const value = await readProtectedState(executor, scope.companyId, key, true);
      if (!value) return null;
      return parse(z.object({ version: z.literal(1), companyId: z.literal(scope.companyId),
        paperclipProjectId: z.literal(scope.paperclipProjectId), userId: z.literal(scope.userId),
        projectIds: z.array(z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/)).max(20),
      }).strict(), value).projectIds;
    });
    if (catalog === null) return null;
    const initial = await readMirrorGrantSnapshot(context, { ...input, projectIds: catalog });
    const read = await readGitHubIssueBoards(scope, issue, catalog, {
      canReadIssue: async () => initial.issueReadable,
      currentGrant: async (_scope, id) => initial.grants.get(id) ?? null,
      finalAuthorization: (_scope, _issue, projectIds) => readMirrorGrantSnapshot(context, { ...input, projectIds }),
      async retained(_scope, _issue, grant) {
        const value = await readProtectedState(db, scope.companyId, registeredMirrorKey(scope, grant)) as GitHubIssueMirror | null;
        if (value?.issue.nodeId !== issue.nodeId || value.issue.url !== issue.url) return null;
        return value.projects.find(card => card.projectId === grant.projectId) ?? null;
      },
      async read(_scope, _issue, grant, deadline) {
        try {
          const current = await db.transaction(tx => nativeConnection(tx as unknown as Db, scope.companyId, grant.connectionId));
          if (current.authorizationDigest !== grant.authorizationRevision) return { state: "denied" };
          const bound = { companyId: scope.companyId, userId: scope.userId, authorizationDigest: grant.authorizationRevision,
            binding: { boardUrl: grant.projectUrl, boardId: grant.projectId, connectionId: grant.connectionId,
              accountId: current.facts.accountId, login: current.facts.login } };
          const { url: _url, ...reference } = parseGitHubProjectBoardUrl(grant.projectUrl);
          const pages: Extract<GitHubProjectObservation, { state: "readable" }>["pages"][number][] = [];
          const observedAt = Date.now();
          let title = "", after: string | null = null;
          for (let index = 0; index < 20 && Date.now() < deadline; index++) {
            const request = validateGitHubProjectPageInput({ ...reference, first: 50, after });
            const received = await fetchBound(bound, request);
            if (Date.now() >= deadline) break;
            const normalized = readGitHubIssueProjectMirrorPage(received.data, request, issue.nodeId);
            title = normalized.title;
            pages.push(normalized.page);
            after = normalized.page.next;
            if (after === null || pages.some(page => page.after === after)) break;
          }
          return { state: "readable", projectId: grant.projectId, url: grant.projectUrl, title,
            authorizationRevision: grant.authorizationRevision, observedAt, pages };
        } catch (error) {
          if (isTransientGitHubReadError(error)) return { state: "unavailable" };
          if (error instanceof GitHubOAuthTransportError
            || (error instanceof HttpError && [401, 403, 404, 409].includes(error.status))) return { state: "denied" };
          throw error;
        }
      },
    });
    if (read.state === "denied") throw forbidden("The linked GitHub issue is no longer readable");
    const fresh = read.boards.filter(board => board.state === "fresh" && board.card && board.grant);
    if (fresh.length) {
      await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        for (const board of fresh) {
          const stateKey = registeredMirrorKey(scope, board.grant!);
          const value: GitHubIssueMirror = { issue, projects: [board.card!] };
          await store(executor).set(identity.pluginId, { scopeKind: "company", scopeId: scope.companyId,
            namespace: GITHUB_PROJECT_BINDING_NAMESPACE, stateKey, value });
          if (!isDeepStrictEqual(await readProtectedState(executor, scope.companyId, stateKey), value)) {
            throw conflict("GitHub Project mirror readback failed");
          }
        }
      });
    }
    const complete = !read.truncated && !read.accessRequired && read.boards.every(board => board.state === "fresh");
    return { state: complete ? "fresh" : "partial", coverage: "registered_projects", accessRequired: read.accessRequired,
      boardReadStates: read.boards.map(({ projectId, state }) => ({ projectId, state })),
      mirror: { issue, projects: read.boards.flatMap(board => board.card ? [board.card] : []) } };
  }

  const mirrorCatalogKey = (scope: Pick<GitHubMirrorReadScope, "companyId" | "paperclipProjectId" | "userId">) =>
    "issue-read-catalog-v1:" + createHash("sha256").update(JSON.stringify(
      [scope.companyId, scope.paperclipProjectId, scope.userId],
    )).digest("hex");

  async function listSavedLinkedIssueBoardAccess(context: BoardImportHostContext, scope: GitHubMirrorReadScope,
    assertCurrentIssue: (executor: Db) => Promise<boolean>) {
    return db.transaction(async transaction => {
      const executor = transaction as unknown as Db;
      const actor = await authorize(executor, context, { companyId: scope.companyId, projectId: scope.paperclipProjectId });
      if (actor.userId !== scope.userId || !(await assertCurrentIssue(executor))) {
        throw forbidden("The linked GitHub issue is no longer readable");
      }
      const retained = await readProtectedState(executor, scope.companyId, mirrorCatalogKey(scope), true);
      if (retained === null) return { grants: [] };
      const catalog = parse(z.object({ version: z.literal(1), companyId: z.literal(scope.companyId),
        paperclipProjectId: z.literal(scope.paperclipProjectId), userId: z.literal(scope.userId),
        projectIds: z.array(z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/)).max(20),
      }).strict(), retained);
      const grants: Array<{ projectId: string; grantId: string }> = [];
      for (const projectId of new Set(catalog.projectIds)) {
        const saved = await readProtectedState(executor, scope.companyId, githubIssueBoardReadGrantKey(scope, projectId), true);
        const grant = githubBoardReadGrantSchema.safeParse(saved);
        if (!grant.success || grant.data.companyId !== scope.companyId
          || grant.data.paperclipProjectId !== scope.paperclipProjectId || grant.data.userId !== scope.userId
          || grant.data.projectId !== projectId) continue;
        grants.push({ projectId, grantId: grant.data.grantId });
      }
      return { grants };
    }, { isolationLevel: "repeatable read" });
  }

  async function changeLinkedIssueBoardAccess(context: BoardImportHostContext, scope: GitHubMirrorReadScope,
    assertCurrentIssue: (executor: Db) => Promise<boolean>,
    action: { op: "register"; boardUrl: string; connectionId: string }
      | { op: "revoke"; projectId: string; expectedGrantId: string }) {
    const projectScope = { companyId: scope.companyId, projectId: scope.paperclipProjectId };
    const assertIssueAccess = async (executor: Db) => {
      const actor = await authorize(executor, context, projectScope);
      if (actor.userId !== scope.userId || !(await assertCurrentIssue(executor))) {
        throw forbidden("The linked GitHub issue is no longer readable");
      }
    };
    const authority = async (executor: Db, connectionId: string) => {
      await assertIssueAccess(executor);
      const current = await nativeConnection(executor, scope.companyId, connectionId);
      return verifyNativeGitHubConsent(executor, current.connection, scope.userId, current.facts, current.credentialRevision);
    };
    const run = async <T>(fn: (executor: Db) => Promise<T>) => db.transaction(async tx => {
      const executor = tx as unknown as Db;
      await executor.execute(sql`set local statement_timeout = '10000ms'`);
      await executor.execute(sql`set local lock_timeout = '5000ms'`);
      return fn(executor);
    });
    const cabinet = (executor: Db) => {
      const options = { scopeId: scope.companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE };
      const read = (key: string) => readProtectedState(executor, scope.companyId, key, true);
      const save = (stateKey: string, value: unknown) => store(executor).set(identity.pluginId,
        { scopeKind: "company", ...options, stateKey, value });
      return {
        lockCatalog: async () => { await lockBinding(executor, scope.companyId, scope.paperclipProjectId); },
        assertIssueAccess: () => assertIssueAccess(executor),
        currentAuthority: (input: { connectionId: string }) => authority(executor, input.connectionId),
        readGrant: async (input: { projectId: string }) =>
          await read(githubIssueBoardReadGrantKey(scope, input.projectId)) as GitHubBoardReadRegistration | null,
        readCatalog: async () =>
          await read(mirrorCatalogKey(scope)) as GitHubBoardReadCatalog | null,
        saveGrant: (value: { projectId: string }) => save(githubIssueBoardReadGrantKey(scope, value.projectId), value),
        saveCatalog: (value: unknown) => save(mirrorCatalogKey(scope), value),
        removeGrant: (input: { projectId: string }) =>
          store(executor).delete(identity.pluginId, "company", githubIssueBoardReadGrantKey(scope, input.projectId), options),
      };
    };
    const audit = (executor: Db, projectId: string) => executor.insert(activityLog).values({
      companyId: scope.companyId, actorType: "user", actorId: scope.userId, responsibleUserId: scope.userId,
      action: "github_project_read_access." + action.op, entityType: "issue", entityId: scope.paperclipIssueId,
      details: { projectId, paperclipProjectId: scope.paperclipProjectId },
    });
    try {
      if (action.op === "revoke") return await run(async executor => {
        const result = await revokeGitHubBoardRead({ ...scope, projectId: action.projectId,
          expectedGrantId: action.expectedGrantId }, cabinet(executor));
        await audit(executor, result.projectId);
        return result;
      });
      const board = parseGitHubProjectBoardUrl(action.boardUrl);
      const verified = await run(executor => authority(executor, action.connectionId));
      if (!verified) throw forbidden("Reconnect GitHub as the signed-in user to register a board.");
      const page = { ownerType: board.ownerType, owner: board.owner, number: board.number, after: null, first: 1 };
      const result = await readPage({ companyId: scope.companyId, connectionId: action.connectionId, page,
        expectedAccountId: verified.accountId, expectedLogin: verified.login,
        actor: { actorType: "user", actorId: scope.userId } });
      const checked = checkedGitHubProjectPage(result.page, page);
      return await registerGitHubBoardRead({ ...scope, connectionId: action.connectionId, projectId: checked.board.id,
        projectUrl: board.url }, {
        currentAuthority: () => run(executor => authority(executor, action.connectionId)),
        probeBoard: async () => ({ projectId: checked.board.id, projectUrl: board.url, ...result.account,
          authorizationRevision: result.authorizationDigest }),
        withTransaction: fn => run(async executor => {
          const saved = await fn(cabinet(executor));
          await audit(executor, checked.board.id);
          return saved;
        }),
      });
    } catch (error) {
      if (error instanceof GitHubBoardRegistrationRefused) throw conflict(error.message);
      throw error;
    }
  }

  return {
    // Internal host composition only; deliberately absent from the worker RPC discriminator.
    async authorizeBindingScope(executor: Db, context: BoardImportHostContext, input: unknown) {
      const scope = await authorize(executor, context, input);
      await lockBinding(executor, scope.companyId, scope.projectId);
      return { ...scope, pluginId: identity.pluginId, pluginKey: identity.pluginKey };
    },
    async verifiedBindingSnapshot(executor: Db, context: BoardImportHostContext, input: unknown) {
      return { ...await verifiedBinding(executor, context, input, true), pluginId: identity.pluginId, pluginKey: identity.pluginKey };
    },
    // Subject membership is checked directly; a scheduled run never fabricates a user actor context.
    async verifyDelegatedBindingSnapshot(executor: Db, value: GitHubProjectScheduleGrant) {
      const grant = parseScheduleGrantInput(scheduleGrantSchema, value);
      if (grant.pluginId !== identity.pluginId) throw forbidden("Delegated native board plugin differs");
      const scope = await authorizeSubject(executor, { companyId: grant.companyId, projectId: grant.projectId }, grant.grantedByUserId, true);
      const snapshot = await verifiedSubjectBinding(executor, scope, true);
      if (!matchesNativeScheduleGrantSnapshot(grant, snapshot)) throw conflict("Delegated native board authorization changed");
      return { ...snapshot, pluginId: identity.pluginId, pluginKey: identity.pluginKey };
    },
    async readScheduledProjectPage(authority: unknown, target: ScheduledBoardTarget, value: { page: unknown }) {
      assertScheduledTarget(target);
      const inspected = await validateScheduledPage(authority, target);
      if (!scheduledReadPage) throw forbidden("Native scheduled GitHub page reader is not configured");
      const page = validateGitHubProjectPageInput(parse(z.object({ page: z.unknown() }).strict(), value).page);
      const reference = parseGitHubProjectBoardUrl(inspected.binding.boardUrl);
      if (page.ownerType !== reference.ownerType || page.owner !== reference.owner || page.number !== reference.number) {
        throw forbidden("Requested board differs from native destination binding");
      }
      if (page.after === null) await recordScheduledObservation(authority, target, inspected, page);
      // The reader does its own short pre/post validation; no provider I/O is inside a database transaction.
      const result = await scheduledReadPage({ authority, target, companyId: target.companyId,
        connectionId: inspected.binding.connectionId, page, expectedAccountId: inspected.binding.accountId,
        expectedLogin: inspected.binding.login, authorizationDigest: inspected.authorizationDigest });
      const checked = checkedGitHubProjectPage(result.page, page);
      if (checked.board.id !== inspected.binding.boardId || result.account.accountId !== inspected.binding.accountId
        || result.account.login.toLowerCase() !== inspected.binding.login.toLowerCase()
        || result.authorizationDigest !== inspected.authorizationDigest) throw conflict("GitHub board or account identity changed");
      await recordScheduledObservation(authority, target, inspected, page, checked.data);
      return checked.data;
    },
    async assertScheduledImportBinding(executor: Db, authority: unknown, target: ScheduledBoardTarget, value: unknown) {
      assertScheduledTarget(target);
      const intent = validateBoardImportIntent(value, target.companyId);
      if (intent.projectId !== target.projectId) throw forbidden("Scheduled import destination differs");
      const current = await requireScheduledAccess().validate(executor, authority, target, "prepare-import");
      const attestation = await readProtectedState(executor, target.companyId, `attestation:${target.projectId}`, true);
      assertGitHubProjectAttestedIntent(attestation, current.binding, intent, current.authorizationDigest);
      return current;
    },
    async listConnections(context: BoardImportHostContext, input: unknown) {
      const scope = await authorize(db, context, input);
      const rows = await db.select({ connection: toolConnections }).from(toolConnections).innerJoin(toolApplications,
        and(eq(toolApplications.id, toolConnections.applicationId), eq(toolApplications.companyId, scope.companyId),
          eq(toolApplications.status, "active"), isNull(toolApplications.archivedAt)))
        .where(and(eq(toolConnections.companyId, scope.companyId), eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"))).limit(101);
      if (rows.length > 100) throw conflict("Native connection listing exceeds its bounded limit; narrow company configuration first");
      const connections = rows.flatMap(({ connection: row }) => {
        const facts = record(record(row.config.providerMetadata).githubOAuth), grantedScopes = facts.grantedScopes;
        return isNativeGitHubOAuthConnection(row) && typeof facts.accountId === "number" && typeof facts.login === "string"
          && Array.isArray(grantedScopes)
          && githubScopesSatisfy(grantedScopes, githubOAuthRequiredScopes(githubStoredPrivateRepoAccessOptIn(row.config)))
          && !githubScopesExceed(grantedScopes, githubStoredPrivateRepoAccessOptIn(row.config))
          ? [{ connectionId: row.id, name: row.name, accountId: facts.accountId, login: facts.login,
            lastVerifiedAt: typeof facts.checkedAt === "string" ? facts.checkedAt : null }] : [];
      });
      return { companyId: scope.companyId, projectId: scope.projectId, connections };
    },
    async readBinding(context: BoardImportHostContext, input: unknown) {
      const scope = await authorize(db, context, input);
      return retained(db, scope.companyId, scope.projectId);
    },
    async bind(context: BoardImportHostContext, value: unknown) {
      const input = parse(bindSchema, value);
      const scope = await authorize(db, context, { companyId: input.companyId, projectId: input.projectId });
      const reference = parseGitHubProjectBoardUrl(input.boardUrl);
      const selected = await nativeConnection(db, scope.companyId, input.connectionId);
      const page = { ownerType: reference.ownerType, owner: reference.owner, number: reference.number, after: null, first: 1 };
      const result = await readPage({ companyId: scope.companyId, connectionId: input.connectionId, page,
        expectedAccountId: selected.facts.accountId, expectedLogin: selected.facts.login,
        actor: { actorType: "user", actorId: scope.userId } });
      const checked = checkedGitHubProjectPage(result.page, page);
      if (result.account.accountId !== selected.facts.accountId || result.account.login.toLowerCase() !== selected.facts.login.toLowerCase()) {
        throw conflict("GitHub account changed before binding");
      }
      return db.transaction(async tx => {
        const executor = tx as unknown as Db;
        const startedAt = Date.now();
        await executor.execute(sql`set local statement_timeout = '10000ms'`);
        await executor.execute(sql`set local lock_timeout = '5000ms'`);
        await authorize(executor, context, { companyId: scope.companyId, projectId: scope.projectId });
        await lockBinding(executor, scope.companyId, scope.projectId);
        const current = await nativeConnection(executor, scope.companyId, input.connectionId);
        if (!isDeepStrictEqual(current.facts, selected.facts) || current.authorizationDigest !== result.authorizationDigest) {
          throw conflict("GitHub connection changed before binding");
        }
        const existing = await retained(executor, scope.companyId, scope.projectId);
        if (existing) {
          if (existing.boardUrl !== input.boardUrl || existing.boardId !== checked.board.id
            || existing.connectionId !== input.connectionId || existing.accountId !== result.account.accountId
            || existing.login.toLowerCase() !== result.account.login.toLowerCase()) {
            throw conflict("A different native board binding is retained; no association was replaced");
          }
          return existing;
        }
        const binding = parse(bindingSchema, { ...input, version: 1, boardId: checked.board.id,
          ...result.account, boundByUserId: scope.userId, boundAt: new Date().toISOString() });
        assertTransactionDeadline(startedAt);
        await store(executor).set(identity.pluginId, { scopeKind: "company", scopeId: scope.companyId,
          namespace: GITHUB_PROJECT_BINDING_NAMESPACE, stateKey: key(scope.projectId), value: binding });
        if (!isDeepStrictEqual(await retained(executor, scope.companyId, scope.projectId), binding)) {
          throw conflict("Native board binding readback failed; inspect before retrying");
        }
        assertTransactionDeadline(startedAt);
        return binding;
      });
    },
    async readProjectPage(context: BoardImportHostContext, value: unknown) {
      const input = parse(readSchema, value), page = validateGitHubProjectPageInput(input.page);
      const scope = await verifiedBinding(db, context, { companyId: input.companyId, projectId: input.projectId });
      const reference = parseGitHubProjectBoardUrl(scope.binding.boardUrl);
      if (page.ownerType !== reference.ownerType || page.owner !== reference.owner || page.number !== reference.number) {
        throw forbidden("Requested board differs from native destination binding");
      }
      if (page.after === null) await recordObservation(context, scope, page);
      const result = await fetchBound(scope, page);
      await recordObservation(context, scope, page, result.data);
      return result.data;
    },
    async readMirrorRegistrationAuthority(executor: Db, context: BoardImportHostContext,
      input: { companyId: string; projectId: string; connectionId: string }) {
      const scope = await authorize(executor, context, { companyId: input.companyId, projectId: input.projectId });
      const current = await nativeConnection(executor, scope.companyId, input.connectionId);
      return verifyNativeGitHubConsent(executor, current.connection, scope.userId,
        current.facts, current.credentialRevision);
    },
    changeLinkedIssueBoardAccess,
    listSavedLinkedIssueBoardAccess,
    refreshRegisteredIssueMirrors,
    async refreshLinkedIssueMirror(
      context: BoardImportHostContext,
      input: { companyId: string; projectId: string; issueId: string; objectId: string; issue: GitHubIssueIdentity; requestedProjectId?: string; assertCurrentIssue: (executor: Db) => Promise<boolean> },
    ): Promise<GitHubMirrorRead> {
      const { companyId, projectId, issueId, objectId, issue } = input;
      const scopeInput = { companyId, projectId };
      const initial = await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        const scope = await authorize(executor, context, scopeInput);
        await lockBinding(executor, scope.companyId, scope.projectId);
        const binding = await retained(executor, scope.companyId, scope.projectId);
        if (!binding || (input.requestedProjectId && input.requestedProjectId !== binding.boardId)) return null;
        return await verifiedSubjectBinding(executor, scope);
      });
      if (!initial) return { state: "denied", coverage: "access_required", mirror: { issue, projects: [] } };
      const cacheIdentity = [companyId, projectId, issueId, objectId, initial.userId, initial.binding.boardId,
        initial.binding.connectionId, initial.authorizationDigest];
      const stateKey = "issue-mirror-v2:" + createHash("sha256").update(JSON.stringify(cacheIdentity)).digest("hex");
      const board = parseGitHubProjectBoardUrl(initial.binding.boardUrl);
      const pages: Extract<GitHubProjectObservation, { state: "readable" }>["pages"][number][] = [];
      const startedAt = Date.now();
      const deadline = startedAt + 20_000;
      let completedInTime = true;
      let unavailable = false;
      let after: string | null = null;
      let title = "";
      for (let index = 0; index < 20 && Date.now() < deadline; index++) {
        const { url: _url, ...reference } = board;
        const request = validateGitHubProjectPageInput({ ...reference, first: 50, after });
        let received: Awaited<ReturnType<typeof fetchBound>>;
        try {
          received = await fetchBound(initial, request);
        } catch (error) {
          // A rate limit, a GitHub 5xx or a timeout says nothing about access: keep the saved card.
          if (isTransientGitHubReadError(error)) {
            unavailable = true;
            break;
          }
          // Lost access on GitHub: drop the card. The caller decides what else to show.
          if (error instanceof GitHubOAuthTransportError
            || (error instanceof HttpError && [401, 403, 404, 409].includes(error.status))) {
            return { state: "denied", coverage: "bound_project", mirror: { issue, projects: [] } };
          }
          throw error;
        }
        if (Date.now() >= deadline) {
          completedInTime = false;
          break;
        }
        const normalized = readGitHubIssueProjectMirrorPage(received.data, request, issue.nodeId);
        title = normalized.title;
        pages.push(normalized.page);
        after = normalized.page.next;
        if (after === null) break;
        if (pages.some(page => page.after === after)) break;
      }
      return await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        const current = await verifiedBinding(executor, context, scopeInput);
        if (!isDeepStrictEqual(current.binding, initial.binding) || current.authorizationDigest !== initial.authorizationDigest) {
          throw conflict("GitHub Project read authority changed");
        }
        if (!(await input.assertCurrentIssue(executor))) throw forbidden("The linked GitHub issue is no longer readable");
        const retained = await readProtectedState(executor, companyId, stateKey, true) as GitHubIssueMirror | null;
        const previous = retained?.issue.nodeId === issue.nodeId && retained.issue.url === issue.url
          ? { issue, projects: retained.projects.filter(card => card.projectId === current.binding.boardId
            && card.authorizationRevision === current.authorizationDigest) } : { issue, projects: [] };
        if (unavailable) return { state: "unavailable", coverage: "bound_project", mirror: previous };
        if (!completedInTime || Date.now() >= deadline) return { state: "partial", coverage: "bound_project", mirror: previous };
        const read = updateGitHubIssueMirror(previous, {
          state: "readable", projectId: current.binding.boardId, title, url: board.url,
          authorizationRevision: current.authorizationDigest, observedAt: startedAt, pages,
        }, Date.now());
        if (read.state === "fresh" && read.mirror !== previous) {
          if (Date.now() >= deadline) return { state: "partial", coverage: "bound_project", mirror: previous };
          await store(executor).set(identity.pluginId, { scopeKind: "company", scopeId: companyId,
            namespace: GITHUB_PROJECT_BINDING_NAMESPACE, stateKey, value: read.mirror });
          if (!isDeepStrictEqual(await readProtectedState(executor, companyId, stateKey), read.mirror)) {
            throw conflict("GitHub Project mirror readback failed");
          }
        }
        if (read.state === "denied") return { state: "denied", mirror: { issue, projects: [] } };
        return { ...read, coverage: "bound_project" };
      });
    },
    async assertImportBinding(context: BoardImportHostContext, value: unknown, executor: Db = db) {
      const intent = validateBoardImportIntent(value, context.companyId);
      const scope = await verifiedBinding(executor, context, { companyId: intent.companyId, projectId: intent.projectId });
      if (scope.binding.boardId !== intent.boardId || scope.binding.boardUrl !== intent.boardUrl) {
        throw forbidden("Import target differs from host-owned native board binding");
      }
      const attestation = await readProtectedState(executor, scope.companyId, `attestation:${scope.projectId}`, true);
      assertGitHubProjectAttestedIntent(attestation, scope.binding, intent, scope.authorizationDigest);
      return scope.binding;
    },
  };
}
