import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, companySecrets, plugins, pluginState, projects, toolApplications, toolConnections } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { toolConnectionSnapshotColumns } from "./tool-connection-snapshot.js";
import { isNativeGitHubOAuthConnection } from "./github-oauth-transport.js";
import { checkedGitHubProjectPage, parseGitHubProjectBoardUrl, validateGitHubProjectPageInput,
  githubProjectAuthorizationDigest,
  type GitHubProjectPageInput } from "./github-oauth-project-page.js";
import { validateBoardImportContext, validateBoardImportIntent, type BoardImportHostContext } from "./plugin-imported-issues-contract.js";
import { advanceGitHubProjectAttestation, assertGitHubProjectAttestedIntent, pendingGitHubProjectAttestation,
  type GitHubProjectAttestation } from "./github-project-board-attestation.js";

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

/** The host, not worker-writable state or secret refs, owns the OAuth authority for each destination. */
export function pluginGitHubProjectBoardService(
  db: Db, identity: { pluginId: string; pluginKey: string }, readPage: ReadPage,
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
    if (scope.companyId !== context.companyId || identity.pluginKey !== GITHUB_PROJECT_IMPORTER_KEY) {
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
    if (!plugin || plugin.key !== identity.pluginKey || !["ready", "installed"].includes(plugin.status)
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
      || !Array.isArray(grantedScopes) || !["repo", "project"].every(scope => grantedScopes.includes(scope))) {
      throw forbidden("Selected native GitHub OAuth connection is not verified and active");
    }
    const accessRefs = connection.credentialSecretRefs.filter(ref => ref.configPath === "oauth.access_token");
    if (accessRefs.length !== 1) throw forbidden("Native GitHub OAuth access credential metadata is missing or ambiguous");
    const [secret] = await executor.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion }).from(companySecrets)
      .where(and(eq(companySecrets.id, accessRefs[0].secretId), eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt))).for("share").limit(1);
    if (!secret) throw forbidden("Native GitHub OAuth access credential is not active in this company");
    return { connection, facts: { accountId: facts.accountId, login: facts.login },
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
  async function verifiedBinding(executor: Db, context: BoardImportHostContext, input: unknown) {
    const scope = await authorize(executor, context, input);
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
    return { ...scope, binding, authorizationDigest: current.authorizationDigest };
  }
  async function fetchBound(scope: Awaited<ReturnType<typeof verifiedBinding>>, page: GitHubProjectPageInput) {
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
  return {
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
          && Array.isArray(grantedScopes) && ["repo", "project"].every(scope => grantedScopes.includes(scope))
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
