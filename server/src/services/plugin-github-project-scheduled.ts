import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, pluginJobs, pluginJobRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden } from "../errors.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE, GITHUB_PROJECT_IMPORTER_KEY,
  pluginGitHubProjectBoardService } from "./plugin-github-project-board.js";
import { matchesNativeScheduleGrantSnapshot, readRetainedNativeScheduleGrant } from "./plugin-github-project-schedule-grants.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY, type GitHubProjectScheduleGrant } from "./github-project-schedule-grant-contract.js";
import { pluginImportedIssuesService } from "./plugin-imported-issues.js";
import { boardImportDigest, validateBoardImportIntent, type BoardImportIntent,
  type BoardImportReceipt } from "./plugin-imported-issues-contract.js";
import { parseGitHubProjectBoardUrl, checkedGitHubProjectPage, type GitHubProjectPageInput } from "./github-oauth-project-page.js";
import { assertCompleteGitHubProjectAttestation, assertGitHubProjectAttestedIntent } from "./github-project-board-attestation.js";
import { createScheduledBoardProgressPlan, scheduledBoardProgressService, summarizeScheduledBoardProgress,
  selectScheduledBoardProgressBatch,
  type ScheduledBoardProgress, type ScheduledBoardProgressPlan, type ScheduledBoardProgressSummary } from "./github-project-scheduled-progress.js";
import type { ScheduledBoardAccess, ScheduledBoardAuthority, ScheduledBoardTarget,
  ScheduledGitHubPageReader, VerifiedScheduledBoard } from "./github-project-scheduled-contract.js";
import { readVerifiedExistingBoardReference, type ExistingBoardReferenceWitness } from "./github-project-existing-reference.js";

const targetSchema = z.object({ pluginId: z.string().uuid(), companyId: z.string().uuid(),
  projectId: z.string().uuid(), jobId: z.string().uuid(), jobRunId: z.string().uuid() }).strict();
const leaseSchema = targetSchema.extend({ version: z.literal(1), revision: z.number().int().positive().safe(),
  grantId: z.string().uuid(), grantRevision: z.number().int().positive().safe(), ownerEpoch: z.string().min(1).max(128),
  status: z.enum(["active", "settled", "held"]), expiresAt: z.string().datetime(),
  attempted: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20), runStartedAtExact: z.string().min(1).max(128),
  result: z.object({ created: z.number().int().nonnegative(), reused: z.number().int().nonnegative() }).strict().nullable(),
}).strict();
type Lease = z.infer<typeof leaseSchema>;
type Custody = { ownerEpoch: string; isCurrent: () => boolean; signal?: AbortSignal };
type Issued = { verified: VerifiedScheduledBoard; grant: GitHubProjectScheduleGrant; lease: Lease;
  custody: Custody; startedAt: number; monotonicAt: number; prepared: Set<string>; planned: Set<string>;
  progress?: ScheduledBoardProgress; progressPlan?: ScheduledBoardProgressPlan };
export interface ScheduledBoardRunResult {
  /** created/reused/receipts describe only real native held imports, never existing task references. */
  status: "verified" | "held"; complete: boolean; created: number; reused: number;
  receipts: BoardImportReceipt[]; reason?: string; batchVerified: boolean; progress?: ScheduledBoardProgressSummary;
  preservedExisting: number; existingReferences: ExistingBoardReferenceWitness[];
}
export type { ScheduledBoardProgressSummary } from "./github-project-scheduled-progress.js";
const TOTAL_MS = 60_000, LEASE_MS = 90_000;

/** Native host composition only. No worker/RPC operation or user impersonation. Default disabled. */
export function createScheduledGitHubProjectBoardService(
  db: Db, identity: { pluginId: string; pluginKey: string }, reader: ScheduledGitHubPageReader,
  options: { enabled?: boolean } = {},
) {
  const issued = new WeakMap<object, Issued>();
  const progression = scheduledBoardProgressService(identity);
  const scopeOptions = (companyId: string) => ({ scopeId: companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
  const leaseKey = (projectId: string) => `schedule-lease:${projectId}`;
  const transaction = <T>(work: (executor: Db) => Promise<T>) => db.transaction(async tx => {
    const executor = tx as unknown as Db, started = Date.now();
    await executor.execute(sql`set local statement_timeout = '10000ms'`);
    await executor.execute(sql`set local lock_timeout = '5000ms'`);
    const result = await work(executor);
    if (Date.now() < started || Date.now() - started > 20_000) throw conflict("Scheduled board transaction deadline exceeded");
    return result;
  });
  async function readLease(executor: Db, target: ScheduledBoardTarget): Promise<Lease | null> {
    const value = await pluginStateStore(executor).get(identity.pluginId, "company", leaseKey(target.projectId), scopeOptions(target.companyId));
    if (value === null) return null;
    const parsed = leaseSchema.safeParse(value);
    if (!parsed.success || parsed.data.companyId !== target.companyId || parsed.data.projectId !== target.projectId
      || parsed.data.pluginId !== identity.pluginId) throw conflict("Retained scheduled board lease is invalid");
    return parsed.data;
  }
  async function writeLease(executor: Db, lease: Lease) {
    await pluginStateStore(executor).set(identity.pluginId, { scopeKind: "company", ...scopeOptions(lease.companyId),
      stateKey: leaseKey(lease.projectId), value: lease });
    if (!isDeepStrictEqual(await readLease(executor, lease), lease)) throw conflict("Scheduled board lease readback differs");
  }
  function current(authority: unknown, target: ScheduledBoardTarget) {
    const item = authority && typeof authority === "object" ? issued.get(authority) : undefined;
    if (!item || !isDeepStrictEqual(item.verified.target, target)) throw forbidden("Unissued native board authority");
    const now = Date.now(), elapsed = performance.now() - item.monotonicAt;
    if (!item.custody.isCurrent() || item.custody.signal?.aborted || now < item.startedAt || elapsed < 0
      || elapsed >= TOTAL_MS || now >= item.verified.deadlineMs) throw forbidden("Native board authority is no longer current");
    return item;
  }
  async function nativeRun(executor: Db, target: ScheduledBoardTarget) {
    const [job] = await executor.select().from(pluginJobs).where(and(eq(pluginJobs.id, target.jobId),
      eq(pluginJobs.pluginId, identity.pluginId), eq(pluginJobs.jobKey, GITHUB_PROJECT_BOARD_JOB_KEY))).for("share").limit(1);
    const [run] = await executor.select({ id: pluginJobRuns.id, companyId: pluginJobRuns.companyId,
      status: pluginJobRuns.status, trigger: pluginJobRuns.trigger,
      startedAtExact: sql<string>`${pluginJobRuns.startedAt}::text` }).from(pluginJobRuns).where(and(
      eq(pluginJobRuns.id, target.jobRunId), eq(pluginJobRuns.pluginId, identity.pluginId),
      eq(pluginJobRuns.jobId, target.jobId))).for("share").limit(1);
    if (!job || job.status !== "active" || !run || run.companyId !== target.companyId || run.status !== "running"
      || run.trigger !== "schedule" || typeof run.startedAtExact !== "string" || !run.startedAtExact) {
      throw forbidden("Exact active native board job and running company run required");
    }
    return run.startedAtExact;
  }
  async function verifiedGrant(executor: Db, target: ScheduledBoardTarget) {
    const scope = { companyId: target.companyId, projectId: target.projectId };
    const first = await readRetainedNativeScheduleGrant(executor, identity, scope);
    if (!first || !first.enabled || first.revokedAt !== null || Date.parse(first.expiresAt) <= Date.now()
      || first.jobId !== target.jobId || first.jobKey !== GITHUB_PROJECT_BOARD_JOB_KEY) throw forbidden("Current enabled board schedule grant required");
    // Canonical metadata order first, matching management CRUD; job/run locks come afterwards.
    const snapshot = await boards.verifyDelegatedBindingSnapshot(executor, first);
    const runStartedAtExact = await nativeRun(executor, target);
    const again = await readRetainedNativeScheduleGrant(executor, identity, scope);
    if (!isDeepStrictEqual(first, again) || !matchesNativeScheduleGrantSnapshot(first, snapshot)) {
      throw conflict("Native board grant or credential revision changed");
    }
    return { grant: first, snapshot, runStartedAtExact };
  }
  const access: ScheduledBoardAccess = Object.freeze<ScheduledBoardAccess>({
    inspect: (authority, target) => current(authority, target).verified,
    async validate(executor, authority, target) {
      const item = current(authority, target), fresh = await verifiedGrant(executor, target);
      const lease = await readLease(executor, target);
      if (!isDeepStrictEqual(fresh.grant, item.grant) || !lease || lease.status !== "active"
        || !isDeepStrictEqual(lease, item.lease) || fresh.runStartedAtExact !== item.lease.runStartedAtExact
        || Date.parse(lease.expiresAt) <= Date.now()) throw conflict("Native board lease or delegated state changed");
      current(authority, target);
      return item.verified;
    },
    notePrepared(authority, target, operationId) {
      const item = current(authority, target);
      if (!item.planned.has(operationId) || item.prepared.size >= item.verified.maxItems) throw forbidden("Scheduled import preparation is outside its plan");
      item.prepared.add(operationId);
    },
    ownsPreparation(authority, target, operationId) { return current(authority, target).prepared.has(operationId); },
  });
  const boards = pluginGitHubProjectBoardService(db, identity, async () => { throw forbidden("No operator reader in scheduled composition"); },
    access, input => reader(input, access));
  const imports = pluginImportedIssuesService(db, identity, undefined, { access,
    validateIntent: (executor, authority, target, intent) => boards.assertScheduledImportBinding(executor, authority, target, intent) });
  async function claim(target: ScheduledBoardTarget, custody: Custody) {
    const startedAt = Date.now(), monotonicAt = performance.now();
    const value = await transaction(async executor => {
      const fresh = await verifiedGrant(executor, target), previous = await readLease(executor, target);
      if (previous?.jobRunId === target.jobRunId) throw conflict("Native board run has already consumed its lease");
      if (previous && previous.status !== "settled" && Date.parse(previous.expiresAt) > Date.now()) {
        throw conflict("Another active or uncertain native board lease is retained");
      }
      if (!custody.isCurrent() || custody.signal?.aborted) throw forbidden("Native board dispatch owner changed");
      const lease: Lease = { ...target, version: 1, revision: (previous?.revision ?? 0) + 1,
        grantId: fresh.grant.grantId, grantRevision: fresh.grant.revision, ownerEpoch: custody.ownerEpoch,
        status: "active", expiresAt: new Date(Math.min(startedAt + LEASE_MS, Date.parse(fresh.grant.expiresAt))).toISOString(),
        attempted: [], runStartedAtExact: fresh.runStartedAtExact, result: null };
      await writeLease(executor, lease);
      await executor.insert(activityLog).values({ companyId: target.companyId, actorType: "system", actorId: `job-run:${target.jobRunId}`,
        responsibleUserId: fresh.grant.grantedByUserId, action: "github_project_schedule_run.claimed", entityType: "project",
        entityId: target.projectId, details: { grantId: lease.grantId, grantRevision: lease.grantRevision,
          jobRunId: target.jobRunId, ownerEpoch: lease.ownerEpoch, leaseRevision: lease.revision, noDispatch: true } });
      return { ...fresh, lease };
    });
    const authority = Object.freeze(Object.create(null)) as ScheduledBoardAuthority;
    const verified: VerifiedScheduledBoard = Object.freeze({ target: Object.freeze({ ...target }),
      binding: Object.freeze({ ...value.snapshot.binding }), authorizationDigest: value.snapshot.authorizationDigest,
      owner: Object.freeze({ grantId: value.grant.grantId, grantRevision: value.grant.revision,
        preparedByJobRunId: target.jobRunId, ownerEpoch: custody.ownerEpoch }), grantedByUserId: value.grant.grantedByUserId,
      leaseRevision: value.lease.revision, actorId: `job-run:${target.jobRunId}`, maxItems: value.grant.maxItems,
      deadlineMs: Math.min(startedAt + TOTAL_MS, Date.parse(value.grant.expiresAt)) });
    issued.set(authority, { verified, grant: value.grant, lease: value.lease, custody,
      startedAt, monotonicAt, prepared: new Set(), planned: new Set() });
    return authority;
  }
  async function observe(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget) {
    const verified = current(authority, target).verified, reference = parseGitHubProjectBoardUrl(verified.binding.boardUrl);
    let after: string | null = null;
    for (let count = 0; count < 20; count++) {
      const page: GitHubProjectPageInput = { ownerType: reference.ownerType, owner: reference.owner, number: reference.number, after, first: 50 };
      const data = await boards.readScheduledProjectPage(authority, target, { page });
      const checked = checkedGitHubProjectPage(data, page);
      const root = checked.data as Record<string, { projectV2: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }>;
      const info: { hasNextPage: boolean; endCursor: string | null } = root[page.ownerType].projectV2.items.pageInfo;
      if (!info.hasNextPage) return;
      after = info.endCursor;
    }
    throw conflict("Native board observation exceeded twenty complete pages");
  }
  async function intents(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget) {
    const result = await transaction(async executor => {
      const verified = await access.validate(executor, authority, target, "record-page");
      const value = await pluginStateStore(executor).get(identity.pluginId, "company", `attestation:${target.projectId}`, scopeOptions(target.companyId));
      const observed = assertCompleteGitHubProjectAttestation(value, verified.binding, verified.authorizationDigest);
      const allIntents = observed.issues.map(item => {
        const task = { companyId: target.companyId, projectId: target.projectId, githubIssueNodeId: item.githubIssueNodeId,
          title: item.title, sourceUrl: item.sourceUrl, status: "backlog", assigneeAgentId: null, assigneeUserId: null, noDispatch: true };
        const data = { companyId: target.companyId, projectId: target.projectId,
          taskKey: boardImportDigest(["github-issue", target.companyId, item.githubIssueNodeId]),
          membershipKey: boardImportDigest(["github-board-item", target.companyId, observed.boardId, item.boardItemId]),
          boardId: observed.boardId, boardItemId: item.boardItemId, githubIssueNodeId: item.githubIssueNodeId,
          boardUrl: observed.boardUrl, sourceUpdatedAt: observed.sourceUpdatedAt, task, fields: item.fields };
        const hash = boardImportDigest(["board-import-v1", data]);
        const intent = validateBoardImportIntent({ ...data, operationId: hash, intentHash: hash }, target.companyId);
        assertGitHubProjectAttestedIntent(observed, verified.binding, intent, verified.authorizationDigest);
        return intent;
      });
      const plan = createScheduledBoardProgressPlan(verified, observed, allIntents);
      const progress = await progression.prepare(executor, plan, verified);
      await access.validate(executor, authority, target, "record-page");
      return { plan, progress, selected: selectScheduledBoardProgressBatch(plan, progress, verified.maxItems) };
    });
    const item = current(authority, target);
    item.progress = result.progress; item.progressPlan = result.plan;
    return result.selected;
  }
  async function checkpoint(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget,
    intent?: BoardImportIntent, expectedReceipt?: BoardImportReceipt) {
    const item = current(authority, target), expected = item.progress, plan = item.progressPlan;
    if (!expected || !plan) throw conflict("Complete native progression plan required");
    const progress = await transaction(async executor => {
      const verified = await access.validate(executor, authority, target, "read-receipt");
      let next: ScheduledBoardProgress;
      if (intent && expectedReceipt) {
        // Existing importer on this transaction creates a savepoint, not an independent connection.
        // Its real task/hold SHARE locks remain held through the progress CAS and outer commit.
        const scopedImports = pluginImportedIssuesService(executor, identity, undefined, { access,
          validateIntent: (inside, value, scope, input) => boards.assertScheduledImportBinding(inside, value, scope, input) });
        const receipt = await scopedImports.readScheduledReceipt(authority, target, { operationId: intent.operationId });
        if (!receipt || !isDeepStrictEqual(receipt, expectedReceipt)) throw conflict("Native receipt changed before progress checkpoint");
        next = await progression.advance(executor, expected, plan, intent, receipt, verified);
      } else next = await progression.hold(executor, expected, plan, verified);
      await access.validate(executor, authority, target, "read-receipt");
      return next;
    });
    current(authority, target).progress = progress;
    return summarizeScheduledBoardProgress(progress);
  }
  async function preserveExisting(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget, intent: BoardImportIntent) {
    const item = current(authority, target), expected = item.progress, plan = item.progressPlan;
    if (!expected || !plan) throw conflict("Complete native progression plan required");
    const saved = await transaction(async executor => {
      const verified = await access.validate(executor, authority, target, "read-task");
      await boards.assertScheduledImportBinding(executor, authority, target, intent);
      const scopedImports = pluginImportedIssuesService(executor, identity, undefined, { access,
        validateIntent: (inside, value, scope, input) => boards.assertScheduledImportBinding(inside, value, scope, input) });
      // Any existing native ownership wins. Invalid/edited/prepared native state is not a legacy fallback.
      const operation = await scopedImports.readScheduledOperation(authority, target, { operationId: intent.operationId });
      if (operation || await scopedImports.readScheduledTask(authority, target, { githubIssueNodeId: intent.githubIssueNodeId })) return null;
      const witness = await readVerifiedExistingBoardReference(executor, identity, verified, intent);
      if (!witness) return null;
      const progress = await progression.advanceExisting(executor, expected, plan, intent, witness, verified);
      await boards.assertScheduledImportBinding(executor, authority, target, intent);
      await access.validate(executor, authority, target, "read-task");
      return { witness, progress };
    });
    if (!saved) return null;
    current(authority, target).progress = saved.progress;
    return saved.witness;
  }
  async function consume(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget, intent: BoardImportIntent) {
    const updated = await transaction(async executor => {
      await access.validate(executor, authority, target, "prepare-import");
      const lease = (await readLease(executor, target))!;
      if (lease.attempted.includes(intent.operationId) || lease.attempted.length >= current(authority, target).verified.maxItems) {
        throw conflict("Scheduled operation attempt budget already consumed");
      }
      const next = { ...lease, attempted: [...lease.attempted, intent.operationId] };
      await writeLease(executor, next);
      return next;
    });
    current(authority, target).lease = updated;
  }
  async function finish(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget, result: ScheduledBoardRunResult) {
    const item = issued.get(authority)!;
    await transaction(async executor => {
      if (result.status === "verified") await access.validate(executor, authority, target, "read-receipt");
      else await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-project-binding:${target.companyId}:${target.projectId}`},0))`);
      const saved = await readLease(executor, target);
      if (!saved || saved.status !== "active" || saved.revision !== item.lease.revision
        || saved.ownerEpoch !== item.lease.ownerEpoch || saved.jobRunId !== target.jobRunId) throw conflict("Cannot settle another scheduled board lease");
      await writeLease(executor, { ...saved, status: result.status === "verified" ? "settled" : "held",
        result: { created: result.created, reused: result.reused } });
      if (result.status === "verified") {
        const fresh = await verifiedGrant(executor, target);
        if (!isDeepStrictEqual(fresh.grant, item.grant) || fresh.runStartedAtExact !== item.lease.runStartedAtExact) {
          throw conflict("Scheduled authority changed during settlement");
        }
        current(authority, target);
      }
    });
  }
  async function execute(authority: ScheduledBoardAuthority, target: ScheduledBoardTarget): Promise<ScheduledBoardRunResult> {
    const result: ScheduledBoardRunResult = { status: "verified", complete: false, batchVerified: false, created: 0, reused: 0,
      receipts: [], preservedExisting: 0, existingReferences: [] };
    try {
      await observe(authority, target);
      const plan = await intents(authority, target);
      current(authority, target).planned = new Set(plan.map(item => item.operationId));
      for (const intent of plan) {
        await consume(authority, target, intent);
        const existing = await preserveExisting(authority, target, intent);
        if (existing) {
          result.existingReferences.push(existing); result.preservedExisting++; continue;
        }
        const began = await imports.beginScheduled(authority, target, { intent });
        if (began.status === "held") {
          result.status = "held"; result.reason = began.reason;
          result.progress = await checkpoint(authority, target); break;
        }
        if (began.status === "prepared") await imports.commitScheduled(authority, target, { intent });
        const receipt = await imports.readScheduledReceipt(authority, target, { operationId: intent.operationId });
        if (!receipt?.task.noDispatch) throw conflict("Scheduled board receipt does not prove an active hold");
        result.progress = await checkpoint(authority, target, intent, receipt);
        result.receipts.push(receipt);
        if (began.status === "prepared" && receipt.createdTask) result.created++; else result.reused++;
      }
      const progress = current(authority, target).progress;
      if (!progress) throw conflict("Native progression readback required");
      result.progress = summarizeScheduledBoardProgress(progress);
      result.batchVerified = result.status === "verified";
      result.complete = result.batchVerified && result.progress.boardComplete;
      await finish(authority, target, result);
      return result;
    } catch (error) {
      result.status = "held"; result.complete = false; result.batchVerified = false; result.reason = "native-scheduled-run-refused";
      try { await finish(authority, target, result); } catch { throw conflict("Scheduled result is uncertain; lease and receipts must be inspected before retry"); }
      throw error;
    } finally { issued.delete(authority); }
  }
  return Object.freeze({
    async run(value: ScheduledBoardTarget, custody: Custody): Promise<ScheduledBoardRunResult> {
      if (options.enabled !== true) throw forbidden("Native board scheduling is disabled by default");
      const parsed = targetSchema.safeParse(value);
      if (!parsed.success || parsed.data.pluginId !== identity.pluginId || identity.pluginKey !== GITHUB_PROJECT_IMPORTER_KEY
        || !custody || typeof custody.isCurrent !== "function" || !custody.isCurrent()
        || typeof custody.ownerEpoch !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(custody.ownerEpoch)) {
        throw forbidden("Trusted exact native scheduled dispatch required");
      }
      const owned = Object.freeze({ ownerEpoch: custody.ownerEpoch, isCurrent: custody.isCurrent, signal: custody.signal });
      return execute(await claim(parsed.data, owned), parsed.data);
    },
  });
}
