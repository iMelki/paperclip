import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, like, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyMemberships, pluginJobs, pluginState } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE, pluginGitHubProjectBoardService,
  type GitHubProjectBinding } from "./plugin-github-project-board.js";
import { boardImportDigest, type BoardImportHostContext } from "./plugin-imported-issues-contract.js";
import { assertScheduleGrantRevision, createScheduleGrantSchema, grantScopeSchema,
  GITHUB_PROJECT_BOARD_JOB_KEY, GITHUB_PROJECT_GRANT_MAX_AGE_MS, parseScheduleGrantInput,
  durableScheduleGrantKey, legacyScheduleGrantMarker, reconcileScheduleGrantSchema, revokeScheduleGrantSchema, scheduleGrantDeadline,
  scheduleGrantSchema, type GitHubProjectScheduleGrant } from "./github-project-schedule-grant-contract.js";

type BoardService = ReturnType<typeof pluginGitHubProjectBoardService>;
type Scope = { companyId: string; projectId: string };
type Snapshot = Awaited<ReturnType<BoardService["verifiedBindingSnapshot"]>>;
type BindingSnapshot = { binding: GitHubProjectBinding; authorizationDigest: string };
export type ScheduleGrantStatus = "absent" | "disabled" | "enabled" | "revoked" | "expired" | "stale";
export interface ScheduleGrantRead {
  status: ScheduleGrantStatus; enabled: boolean; grant: GitHubProjectScheduleGrant | null;
}

/** Metadata only: possession of this JSON is never scheduled execution authority. */
export function matchesNativeScheduleGrantSnapshot(grant: GitHubProjectScheduleGrant, snapshot: BindingSnapshot) {
  return grant.bindingDigest === boardImportDigest(snapshot.binding)
    && grant.authorizationDigest === snapshot.authorizationDigest
    && grant.boardId === snapshot.binding.boardId && grant.boardUrl === snapshot.binding.boardUrl
    && grant.connectionId === snapshot.binding.connectionId && grant.accountId === snapshot.binding.accountId
    && grant.login === snapshot.binding.login;
}
export async function readRetainedNativeScheduleGrant(
  executor: Db, identity: { pluginId: string; pluginKey: string }, scope: Scope,
) {
  const parsed = parseScheduleGrantInput(grantScopeSchema, scope);
  const value = await pluginStateStore(executor).get(identity.pluginId, "company", `schedule-grant:${parsed.projectId}`,
    { scopeId: parsed.companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
  const durable = await pluginStateStore(executor).get(identity.pluginId, "company", durableScheduleGrantKey(parsed.projectId),
    { scopeId: parsed.companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
  if (value === null && durable === null) return null;
  if (value === null) throw conflict("Durable schedule grant lacks legacy marker");
  const marker = parseScheduleGrantInput(scheduleGrantSchema, value);
  if (marker.version !== 1) throw conflict("Legacy schedule marker must be version 1");
  const grant = durable === null ? marker : parseScheduleGrantInput(scheduleGrantSchema, durable);
  if (durable !== null && !isDeepStrictEqual(marker, legacyScheduleGrantMarker(grant))) {
    throw conflict("Durable schedule grant and legacy marker differ");
  }
  if (grant.pluginId !== identity.pluginId || grant.companyId !== parsed.companyId || grant.projectId !== parsed.projectId) {
    throw conflict("Retained GitHub board schedule grant scope differs");
  }
  return grant;
}

/** Host-only persistence, not scheduler authority. No worker RPC or grant JSON can execute an import. */
export function pluginGitHubProjectScheduleGrants(
  db: Db, identity: { pluginId: string; pluginKey: string }, boards: BoardService,
) {
  const key = (projectId: string) => `schedule-grant:${projectId}`;
  const options = (companyId: string) => ({ scopeId: companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
  const assertOwner = (scope: { pluginId: string; pluginKey: string }) => {
    if (scope.pluginId !== identity.pluginId || scope.pluginKey !== identity.pluginKey) {
      throw forbidden("Native board grant service plugin ownership differs");
    }
  };
  const sameSnapshot = matchesNativeScheduleGrantSnapshot;
  const retained = (executor: Db, scope: Scope) => readRetainedNativeScheduleGrant(executor, identity,
    { companyId: scope.companyId, projectId: scope.projectId });
  async function job(executor: Db, jobId: string) {
    const [row] = await executor.select({ id: pluginJobs.id, key: pluginJobs.jobKey, status: pluginJobs.status })
      .from(pluginJobs).where(and(eq(pluginJobs.id, jobId), eq(pluginJobs.pluginId, identity.pluginId),
        eq(pluginJobs.jobKey, GITHUB_PROJECT_BOARD_JOB_KEY))).for("share").limit(1);
    if (!row || !["active", "paused"].includes(row.status)) throw forbidden("Matching native board job required; repository jobs are not board jobs");
    return row;
  }
  async function grantorIsActive(executor: Db, grant: GitHubProjectScheduleGrant) {
    const [member] = await executor.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, grant.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, grant.grantedByUserId), eq(companyMemberships.status, "active")))
      .for("share").limit(1);
    return Boolean(member && member.role !== "viewer");
  }
  /** A second current grant in the same company would stop that company's scheduled imports, so it cannot be created. */
  async function assertNoOtherCurrentGrant(executor: Db, scope: Scope, jobId: string, now: number) {
    const rows = await executor.select({ stateKey: pluginState.stateKey, valueJson: pluginState.valueJson }).from(pluginState)
      .where(and(eq(pluginState.pluginId, identity.pluginId), eq(pluginState.scopeKind, "company"),
        eq(pluginState.namespace, GITHUB_PROJECT_BINDING_NAMESPACE), eq(pluginState.scopeId, scope.companyId),
        or(like(pluginState.stateKey, "schedule-grant:%"), like(pluginState.stateKey, "durable-schedule-grant:%")))).limit(1001);
    if (rows.length > 1000) throw conflict("Native board grant scan exceeds its bounded limit");
    const pairs = new Map<string, { marker?: GitHubProjectScheduleGrant; durable?: GitHubProjectScheduleGrant }>();
    for (const row of rows) {
      const parsed = scheduleGrantSchema.safeParse(row.valueJson);
      if (!parsed.success || parsed.data.pluginId !== identity.pluginId || parsed.data.companyId !== scope.companyId)
        throw conflict("A retained board schedule grant in this company is invalid; resolve it first");
      const grant = parsed.data, pair = pairs.get(grant.projectId) ?? {};
      if (row.stateKey === key(grant.projectId) && grant.version === 1 && !pair.marker) pair.marker = grant;
      else if (row.stateKey === durableScheduleGrantKey(grant.projectId) && !pair.durable) pair.durable = grant;
      else throw conflict("A retained board schedule grant in this company is invalid; resolve it first");
      pairs.set(grant.projectId, pair);
    }
    for (const [projectId, pair] of pairs) {
      if (!pair.marker || (pair.durable && !isDeepStrictEqual(pair.marker, legacyScheduleGrantMarker(pair.durable))))
        throw conflict("A retained board schedule grant in this company is inconsistent; resolve it first");
      const other = pair.durable ?? pair.marker;
      if (projectId !== scope.projectId && other.jobId === jobId && other.enabled
        && other.revokedAt === null && scheduleGrantDeadline(other) > now)
        throw conflict("Another current board schedule grant exists for this company and job; revoke it before creating a new one");
    }
  }
  function transaction<T>(work: (executor: Db, startedAt: number) => Promise<T>) {
    return db.transaction(async tx => {
      const executor = tx as unknown as Db, startedAt = Date.now();
      await executor.execute(sql`set local statement_timeout = '10000ms'`);
      await executor.execute(sql`set local lock_timeout = '5000ms'`);
      const result = await work(executor, startedAt);
      if (Date.now() - startedAt > 20_000) throw conflict("Native board schedule grant transaction exceeded its bounded deadline");
      return result;
    });
  }
  async function save(executor: Db, grant: GitHubProjectScheduleGrant, actorId: string, action: "created" | "revoked" | "reconciled") {
    const priorDurable = await pluginStateStore(executor).get(identity.pluginId, "company", durableScheduleGrantKey(grant.projectId),
      options(grant.companyId));
    if (grant.version === 2 || priorDurable !== null) {
      await pluginStateStore(executor).set(identity.pluginId, { scopeKind: "company", ...options(grant.companyId),
        stateKey: durableScheduleGrantKey(grant.projectId), value: grant });
    }
    await pluginStateStore(executor).set(identity.pluginId, { scopeKind: "company", ...options(grant.companyId),
      stateKey: key(grant.projectId), value: legacyScheduleGrantMarker(grant) });
    if (!isDeepStrictEqual(await retained(executor, grant), grant)) throw conflict("Native board schedule grant readback failed");
    // Deliberately transactional audit row, with no event publication or agent callback.
    await executor.insert(activityLog).values({ companyId: grant.companyId, actorType: "user", actorId,
      responsibleUserId: actorId, action: `github_project_schedule_grant.${action}`, entityType: "project",
      entityId: grant.projectId, details: { grantId: grant.grantId, revision: grant.revision,
        pluginId: identity.pluginId, jobId: grant.jobId, enabled: grant.enabled, maxItems: grant.maxItems,
        expiresAt: grant.expiresAt, noDispatch: true, importOnly: true } });
    return grant;
  }
  return {
    async create(context: BoardImportHostContext, value: unknown) {
      const input = parseScheduleGrantInput(createScheduleGrantSchema, value);
      return transaction(async executor => {
        const scope = { companyId: input.companyId, projectId: input.projectId };
        // One enabled grant per company and job: serialize creators of the same company before any check.
        await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-project-schedule-grant-company:${identity.pluginId}:${input.companyId}`}, 0))`);
        const snapshot = await boards.verifiedBindingSnapshot(executor, context, scope);
        assertOwner(snapshot);
        await job(executor, input.jobId);
        const previous = await retained(executor, scope);
        assertScheduleGrantRevision(previous, input.expectedRevision);
        const now = Date.now(), expires = input.expiresAt === null ? null : Date.parse(input.expiresAt);
        if (input.enabled) await assertNoOtherCurrentGrant(executor, scope, input.jobId, now);
        if (expires !== null && (expires <= now || expires - now > GITHUB_PROJECT_GRANT_MAX_AGE_MS)) {
          throw forbidden("Board schedule grant expiry must be future and at most 24 hours away");
        }
        const binding = snapshot.binding;
        const grant = parseScheduleGrantInput(scheduleGrantSchema, {
          ...scope, version: input.expiresAt === null ? 2 : 1, pluginId: identity.pluginId, grantId: randomUUID(), revision: input.expectedRevision + 1,
          jobId: input.jobId, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY, enabled: input.enabled,
          maxItems: input.maxItems, boardId: binding.boardId, boardUrl: binding.boardUrl,
          connectionId: binding.connectionId, accountId: binding.accountId, login: binding.login,
          bindingDigest: boardImportDigest(binding), authorizationDigest: snapshot.authorizationDigest,
          grantedByUserId: snapshot.userId, grantedAt: new Date(now).toISOString(), expiresAt: input.expiresAt,
          revokedAt: null, revokedByUserId: null, importOnly: true, noDispatch: true,
        });
        const current = await boards.verifiedBindingSnapshot(executor, context, scope);
        if (!sameSnapshot(grant, current)) throw conflict("Native board authorization changed before grant save");
        return save(executor, grant, snapshot.userId, "created");
      });
    },
    async read(context: BoardImportHostContext, value: unknown): Promise<ScheduleGrantRead> {
      const input = parseScheduleGrantInput(grantScopeSchema, value);
      return transaction(async executor => {
        // Canonical authorization and advisory lock; stale OAuth must not prevent revoke/read of a tombstone.
        assertOwner(await boards.authorizeBindingScope(executor, context, input));
        let snapshot: Snapshot | null = null;
        try { snapshot = await boards.verifiedBindingSnapshot(executor, context, input); }
        catch (error) {
          if (!(error instanceof Error) || !("status" in error) || ![403, 409, 422].includes(Number(error.status))) throw error;
        }
        const grant = await retained(executor, input);
        if (!grant) return { status: "absent", enabled: false, grant: null };
        if (grant.revokedAt !== null) return { status: "revoked", enabled: false, grant };
        if (scheduleGrantDeadline(grant) <= Date.now()) return { status: "expired", enabled: false, grant };
        if (!await grantorIsActive(executor, grant)) return { status: "stale", enabled: false, grant };
        if (!snapshot || !sameSnapshot(grant, snapshot)) return { status: "stale", enabled: false, grant };
        try { await job(executor, grant.jobId); }
        catch (error) {
          if (!(error instanceof Error) || !("status" in error) || Number(error.status) !== 403) throw error;
          return { status: "stale", enabled: false, grant };
        }
        return { status: grant.enabled ? "enabled" : "disabled", enabled: grant.enabled, grant };
      });
    },
    async inspect(context: BoardImportHostContext, value: unknown) {
      const input = parseScheduleGrantInput(grantScopeSchema, value);
      return transaction(async executor => {
        const scope = await boards.authorizeBindingScope(executor, context, input);
        assertOwner(scope);
        const store = pluginStateStore(executor), opts = options(input.companyId);
        const values = await Promise.all([
          store.get(identity.pluginId, "company", key(input.projectId), opts),
          store.get(identity.pluginId, "company", durableScheduleGrantKey(input.projectId), opts),
        ]);
        const grants = values.map(value => value === null ? null : parseScheduleGrantInput(scheduleGrantSchema, value));
        for (const grant of grants) {
          if (grant && (grant.pluginId !== identity.pluginId || grant.companyId !== input.companyId || grant.projectId !== input.projectId)) {
            throw conflict("Schedule inspection scope differs");
          }
        }
        const [marker, durable] = grants;
        const metadata = (grant: GitHubProjectScheduleGrant | null) => grant && ({ version: grant.version,
          revision: grant.revision, enabled: grant.enabled, revoked: grant.revokedAt !== null });
        return { legacy: metadata(marker), durable: metadata(durable),
          consistent: durable === null ? marker === null || marker.version === 1 :
            marker !== null && marker.version === 1 && isDeepStrictEqual(marker, legacyScheduleGrantMarker(durable)) };
      });
    },
    async reconcile(context: BoardImportHostContext, value: unknown) {
      const input = parseScheduleGrantInput(reconcileScheduleGrantSchema, value);
      return transaction(async executor => {
        const scope = await boards.authorizeBindingScope(executor, context,
          { companyId: input.companyId, projectId: input.projectId });
        assertOwner(scope);
        const store = pluginStateStore(executor), opts = options(input.companyId);
        const markerValue = await store.get(identity.pluginId, "company", key(input.projectId), opts);
        const durableValue = await store.get(identity.pluginId, "company", durableScheduleGrantKey(input.projectId), opts);
        const marker = parseScheduleGrantInput(scheduleGrantSchema, markerValue);
        const durable = parseScheduleGrantInput(scheduleGrantSchema, durableValue);
        for (const grant of [marker, durable]) {
          if (grant.pluginId !== identity.pluginId || grant.companyId !== input.companyId || grant.projectId !== input.projectId) {
            throw conflict("Schedule reconciliation scope differs");
          }
        }
        if (marker.version !== 1 || marker.revision !== input.expectedLegacyRevision
          || durable.revision !== input.expectedDurableRevision || isDeepStrictEqual(marker, legacyScheduleGrantMarker(durable))) {
          throw conflict("Schedule reconciliation changed or is not required");
        }
        const revision = Math.max(marker.revision, durable.revision) + 1;
        if (!Number.isSafeInteger(revision)) throw conflict("Schedule reconciliation revision exhausted");
        const revoked = parseScheduleGrantInput(scheduleGrantSchema, { ...marker, enabled: false, revision,
          revokedAt: new Date().toISOString(), revokedByUserId: scope.userId });
        return save(executor, revoked, scope.userId, "reconciled");
      });
    },
    async revoke(context: BoardImportHostContext, value: unknown) {
      const input = parseScheduleGrantInput(revokeScheduleGrantSchema, value);
      return transaction(async executor => {
        const scope = await boards.authorizeBindingScope(executor, context,
          { companyId: input.companyId, projectId: input.projectId });
        assertOwner(scope);
        const previous = await retained(executor, scope);
        assertScheduleGrantRevision(previous, input.expectedRevision);
        if (!previous) throw conflict("No retained board schedule grant to revoke");
        if (previous.revokedAt !== null) return previous;
        // A durable grant must be revoked before rolling back to a version-1-only host.
        // Retain a version-1 tombstone so the old host can safely enumerate it.
        const tombstone = previous.version === 2 ? { version: 1,
          expiresAt: new Date(Date.parse(previous.grantedAt) + GITHUB_PROJECT_GRANT_MAX_AGE_MS).toISOString() } : {};
        const grant = parseScheduleGrantInput(scheduleGrantSchema, { ...previous, ...tombstone, enabled: false,
          revision: previous.revision + 1, revokedAt: new Date(Date.now()).toISOString(), revokedByUserId: scope.userId });
        return save(executor, grant, scope.userId, "revoked");
      });
    },
  };
}
