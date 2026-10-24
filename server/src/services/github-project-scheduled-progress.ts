import { isDeepStrictEqual } from "node:util";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict } from "../errors.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE } from "./plugin-github-project-board.js";
import { assertCompleteGitHubProjectAttestation, assertGitHubProjectAttestedIntent,
  type GitHubProjectAttestation } from "./github-project-board-attestation.js";
import { boardImportDigest, validateBoardImportIntent, type BoardImportIntent,
  type BoardImportReceipt } from "./plugin-imported-issues-contract.js";
import type { VerifiedScheduledBoard } from "./github-project-scheduled-contract.js";
import { assertExistingBoardReferenceWitness, type ExistingBoardReferenceWitness } from "./github-project-existing-reference.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), node = z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/);
const recordSchema = z.object({ version: z.literal(2), revision: z.number().int().positive().safe(),
  pluginId: z.string().uuid(), companyId: z.string().uuid(), projectId: z.string().uuid(), jobId: z.string().uuid(),
  boardId: node, boardUrl: z.string().max(2048), bindingDigest: digest, authorizationDigest: digest,
  grantId: z.string().uuid(), grantRevision: z.number().int().positive().safe(), snapshotDigest: digest,
  totalCount: z.number().int().min(0).max(1000), eligibleCount: z.number().int().min(0).max(1000),
  nextIndex: z.number().int().min(0).max(1000), lastVerifiedOperationId: digest.nullable(), lastVerifiedBoardItemId: node.nullable(),
  nativeReceiptCheckpoints: z.number().int().min(0).max(1000), preservedExistingCheckpoints: z.number().int().min(0).max(1000),
  lastVerificationKind: z.enum(["native-receipt", "preserved-existing-reference"]).nullable(),
  phase: z.enum(["pending", "complete", "held"]), resetReason: z.enum(["new", "new-pass", "source-changed",
    "binding-changed", "authorization-changed", "grant-changed", "job-changed"]).nullable(),
  jobRunId: z.string().uuid(), ownerEpoch: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  leaseRevision: z.number().int().positive().safe(), updatedAt: z.string().datetime(),
}).strict();
export type ScheduledBoardProgress = z.infer<typeof recordSchema>;
export interface ScheduledBoardProgressSummary {
  snapshotDigest: string; totalCount: number; eligibleCount: number; ineligibleCount: number;
  /** Reconciliation checkpoints, not simultaneous hold validity or GitHub field synchronization. */
  verifiedForSnapshot: number; pendingForSnapshot: number; boardComplete: boolean;
  nativeReceiptVerifiedForSnapshot: number; preservedExistingForSnapshot: number;
  resetReason: ScheduledBoardProgress["resetReason"];
}
export interface ScheduledBoardProgressPlan {
  metadata: Pick<ScheduledBoardProgress, "pluginId" | "companyId" | "projectId" | "jobId" | "boardId" | "boardUrl"
    | "bindingDigest" | "authorizationDigest" | "grantId" | "grantRevision" | "snapshotDigest" | "totalCount" | "eligibleCount">;
  intents: BoardImportIntent[];
}
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Pure complete-snapshot plan. No permission or cursor is inferred from caller JSON. */
export function createScheduledBoardProgressPlan(verified: Readonly<VerifiedScheduledBoard>,
  value: GitHubProjectAttestation, values: BoardImportIntent[]): ScheduledBoardProgressPlan {
  const observed = assertCompleteGitHubProjectAttestation(value, verified.binding, verified.authorizationDigest);
  const intents = values.map(value => validateBoardImportIntent(value, verified.target.companyId))
    .sort((a, b) => order(a.boardItemId, b.boardItemId));
  if (intents.length !== observed.issues.length || new Set(intents.map(intent => intent.boardItemId)).size !== intents.length) {
    throw conflict("Complete scheduled manifest must account for every eligible board item exactly once");
  }
  for (const intent of intents) assertGitHubProjectAttestedIntent(observed, verified.binding, intent, verified.authorizationDigest);
  const metadata = { pluginId: verified.target.pluginId, companyId: verified.target.companyId,
    projectId: verified.target.projectId, jobId: verified.target.jobId, boardId: verified.binding.boardId,
    boardUrl: verified.binding.boardUrl, bindingDigest: boardImportDigest(verified.binding),
    authorizationDigest: verified.authorizationDigest, grantId: verified.owner.grantId, grantRevision: verified.owner.grantRevision,
    totalCount: observed.totalCount!, eligibleCount: intents.length };
  const snapshotDigest = boardImportDigest(["scheduled-board-progress-v1", metadata, observed.sourceUpdatedAt,
    [...observed.seenItemIds].sort(order), intents.map(intent => intent.operationId)]);
  return { metadata: { ...metadata, snapshotDigest }, intents };
}
export function summarizeScheduledBoardProgress(value: ScheduledBoardProgress): ScheduledBoardProgressSummary {
  return { snapshotDigest: value.snapshotDigest, totalCount: value.totalCount, eligibleCount: value.eligibleCount,
    ineligibleCount: value.totalCount - value.eligibleCount, verifiedForSnapshot: value.nextIndex,
    nativeReceiptVerifiedForSnapshot: value.nativeReceiptCheckpoints, preservedExistingForSnapshot: value.preservedExistingCheckpoints,
    pendingForSnapshot: value.eligibleCount - value.nextIndex,
    boardComplete: value.phase === "complete" && value.nextIndex === value.eligibleCount, resetReason: value.resetReason };
}
export function selectScheduledBoardProgressBatch(plan: ScheduledBoardProgressPlan, progress: ScheduledBoardProgress, maxItems: number) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20 || progress.snapshotDigest !== plan.metadata.snapshotDigest) {
    throw conflict("Exact complete scheduled manifest and bounded twenty-item limit required");
  }
  validatePosition(progress, plan);
  return plan.intents.slice(progress.nextIndex, progress.nextIndex + maxItems);
}
function validatePosition(value: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan) {
  const previous = plan.intents[value.nextIndex - 1];
  if (value.nextIndex > value.eligibleCount || value.eligibleCount > value.totalCount
    || !consistentCheckpoints(value)
    || (value.phase === "complete") !== (value.nextIndex === value.eligibleCount)
    || (value.nextIndex === 0 ? value.lastVerifiedOperationId !== null || value.lastVerifiedBoardItemId !== null
      : !previous || previous.operationId !== value.lastVerifiedOperationId || previous.boardItemId !== value.lastVerifiedBoardItemId)) {
    throw conflict("Retained scheduled progress position differs from its complete manifest");
  }
}
function consistentCheckpoints(value: ScheduledBoardProgress) {
  return value.nativeReceiptCheckpoints + value.preservedExistingCheckpoints === value.nextIndex
    && (value.nextIndex === 0) === (value.lastVerificationKind === null)
    && (value.lastVerificationKind !== "native-receipt" || value.nativeReceiptCheckpoints > 0)
    && (value.lastVerificationKind !== "preserved-existing-reference" || value.preservedExistingCheckpoints > 0);
}
function assertReceipt(intent: BoardImportIntent, receipt: BoardImportReceipt) {
  const membership = { key: intent.membershipKey, companyId: intent.companyId, projectId: intent.projectId,
    boardId: intent.boardId, boardItemId: intent.boardItemId, githubIssueNodeId: intent.githubIssueNodeId,
    taskId: receipt?.task?.id, boardUrl: intent.boardUrl, sourceUpdatedAt: intent.sourceUpdatedAt, fields: intent.fields };
  if (!receipt?.task?.id || receipt.operationId !== intent.operationId || receipt.task.noDispatch !== true
    || !isDeepStrictEqual(receipt.task, { ...intent.task, id: receipt.task.id })
    || !isDeepStrictEqual(receipt.membership, membership)) throw conflict("Exact held native receipt required before progress advancement");
}
function resetReason(previous: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan): ScheduledBoardProgress["resetReason"] {
  const next = plan.metadata;
  if (previous.bindingDigest !== next.bindingDigest) return "binding-changed";
  if (previous.authorizationDigest !== next.authorizationDigest) return "authorization-changed";
  if (previous.grantId !== next.grantId || previous.grantRevision !== next.grantRevision) return "grant-changed";
  if (previous.jobId !== next.jobId) return "job-changed";
  return "source-changed";
}

/** Internal host persistence only. Caller holds canonical native authority/binding locks on this executor. */
export function scheduledBoardProgressService(identity: { pluginId: string }) {
  const key = (projectId: string) => `schedule-progress:${projectId}`;
  const options = (companyId: string) => ({ scopeId: companyId, namespace: GITHUB_PROJECT_BINDING_NAMESPACE });
  async function read(executor: Db, plan: ScheduledBoardProgressPlan) {
    const scope = plan.metadata;
    const value = await pluginStateStore(executor).get(identity.pluginId, "company", key(scope.projectId), options(scope.companyId));
    if (value === null) return null;
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success || parsed.data.pluginId !== identity.pluginId || parsed.data.companyId !== scope.companyId
      || parsed.data.projectId !== scope.projectId) throw conflict("Invalid retained native progress scope or record");
    if (parsed.data.nextIndex > parsed.data.eligibleCount || parsed.data.eligibleCount > parsed.data.totalCount
      || !consistentCheckpoints(parsed.data)
      || (parsed.data.phase === "complete") !== (parsed.data.nextIndex === parsed.data.eligibleCount)
      || parsed.data.snapshotDigest === scope.snapshotDigest
        && Object.entries(scope).some(([key, expected]) => Reflect.get(parsed.data, key) !== expected)) {
      throw conflict("Retained native progress metadata differs from its complete manifest");
    }
    return parsed.data;
  }
  async function write(executor: Db, value: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan) {
    const parsed = recordSchema.parse(value); validatePosition(parsed, plan);
    await pluginStateStore(executor).set(identity.pluginId, { scopeKind: "company", ...options(value.companyId),
      stateKey: key(value.projectId), value: parsed });
    if (!isDeepStrictEqual(await read(executor, plan), parsed)) throw conflict("Native progress checkpoint readback differs");
    return parsed;
  }
  function provenance(verified: Readonly<VerifiedScheduledBoard>) {
    return { jobRunId: verified.target.jobRunId, ownerEpoch: verified.owner.ownerEpoch,
      leaseRevision: verified.leaseRevision, updatedAt: new Date().toISOString() };
  }
  function assertVerified(plan: ScheduledBoardProgressPlan, verified: Readonly<VerifiedScheduledBoard>) {
    const expected = { pluginId: verified.target.pluginId, companyId: verified.target.companyId,
      projectId: verified.target.projectId, jobId: verified.target.jobId, boardId: verified.binding.boardId,
      boardUrl: verified.binding.boardUrl, bindingDigest: boardImportDigest(verified.binding),
      authorizationDigest: verified.authorizationDigest, grantId: verified.owner.grantId, grantRevision: verified.owner.grantRevision };
    if (identity.pluginId !== verified.target.pluginId
      || Object.entries(expected).some(([key, value]) => Reflect.get(plan.metadata, key) !== value)) {
      throw conflict("Progress manifest differs from current verified native scope");
    }
  }
  async function current(executor: Db, expected: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan) {
    const value = await read(executor, plan);
    if (!isDeepStrictEqual(value, expected) || expected.snapshotDigest !== plan.metadata.snapshotDigest) {
      throw conflict("Native progress compare-and-swap or complete snapshot changed");
    }
    validatePosition(expected, plan);
    return expected;
  }
  return {
    async prepare(executor: Db, plan: ScheduledBoardProgressPlan, verified: Readonly<VerifiedScheduledBoard>) {
      assertVerified(plan, verified);
      const previous = await read(executor, plan), same = previous?.snapshotDigest === plan.metadata.snapshotDigest;
      if (same && previous) { validatePosition(previous, plan); if (previous.phase !== "complete") return previous; }
      const revision = (previous?.revision ?? 0) + 1;
      const reason = !previous ? "new" : same ? "new-pass" : resetReason(previous, plan);
      return write(executor, { ...plan.metadata, version: 2, revision, nextIndex: 0,
        lastVerifiedOperationId: null, lastVerifiedBoardItemId: null,
        nativeReceiptCheckpoints: 0, preservedExistingCheckpoints: 0, lastVerificationKind: null,
        phase: plan.intents.length === 0 ? "complete" : "pending", resetReason: reason, ...provenance(verified) }, plan);
    },
    async advance(executor: Db, expected: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan,
      intent: BoardImportIntent, receipt: BoardImportReceipt, verified: Readonly<VerifiedScheduledBoard>) {
      assertVerified(plan, verified);
      await current(executor, expected, plan);
      if (plan.intents[expected.nextIndex]?.operationId !== intent.operationId) throw conflict("Cannot skip a native progress item");
      assertReceipt(intent, receipt);
      const nextIndex = expected.nextIndex + 1;
      return write(executor, { ...expected, revision: expected.revision + 1, nextIndex,
        lastVerifiedOperationId: intent.operationId, lastVerifiedBoardItemId: intent.boardItemId,
        nativeReceiptCheckpoints: expected.nativeReceiptCheckpoints + 1, lastVerificationKind: "native-receipt",
        phase: nextIndex === plan.intents.length ? "complete" : "pending", ...provenance(verified) }, plan);
    },
    async advanceExisting(executor: Db, expected: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan,
      intent: BoardImportIntent, witness: ExistingBoardReferenceWitness, verified: Readonly<VerifiedScheduledBoard>) {
      assertVerified(plan, verified);
      await current(executor, expected, plan);
      if (plan.intents[expected.nextIndex]?.operationId !== intent.operationId) throw conflict("Cannot skip a native progress item");
      assertExistingBoardReferenceWitness(intent, witness);
      if (witness.pluginId !== identity.pluginId) throw conflict("Existing reference plugin differs from native progress");
      const nextIndex = expected.nextIndex + 1;
      return write(executor, { ...expected, revision: expected.revision + 1, nextIndex,
        lastVerifiedOperationId: intent.operationId, lastVerifiedBoardItemId: intent.boardItemId,
        preservedExistingCheckpoints: expected.preservedExistingCheckpoints + 1,
        lastVerificationKind: "preserved-existing-reference",
        phase: nextIndex === plan.intents.length ? "complete" : "pending", ...provenance(verified) }, plan);
    },
    async hold(executor: Db, expected: ScheduledBoardProgress, plan: ScheduledBoardProgressPlan,
      verified: Readonly<VerifiedScheduledBoard>) {
      assertVerified(plan, verified);
      await current(executor, expected, plan);
      return write(executor, { ...expected, revision: expected.revision + 1, phase: "held", ...provenance(verified) }, plan);
    },
  };
}
