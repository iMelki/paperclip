import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// In-memory stand-in for the plugin state table: no database is opened.
const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => ({
    get: async (pluginId: string, kind: string, key: string, options: { scopeId?: string; namespace?: string } = {}) =>
      stored.get([pluginId, kind, options.scopeId, options.namespace, key].join("|")) ?? null,
    set: async (pluginId: string, input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string; value: unknown }) => {
      stored.set([pluginId, input.scopeKind, input.scopeId, input.namespace, input.stateKey].join("|"), structuredClone(input.value));
    },
  }),
}));

import { GITHUB_PROJECT_BINDING_NAMESPACE } from "../services/plugin-github-project-board.js";
import { scheduledBoardProgressService, selectScheduledBoardProgressBatch, summarizeScheduledBoardProgress,
  type ScheduledBoardProgressPlan } from "../services/github-project-scheduled-progress.js";
import type { VerifiedScheduledBoard } from "../services/github-project-scheduled-contract.js";
import type { BoardImportIntent, BoardImportReceipt } from "../services/plugin-imported-issues-contract.js";
import { boardImportDigest } from "../services/plugin-imported-issues-contract.js";

const PLUGIN = "10000000-0000-4000-8000-000000000001";
const COMPANY = "20000000-0000-4000-8000-000000000002";
const PROJECT = "30000000-0000-4000-8000-000000000003";
const JOB = "40000000-0000-4000-8000-000000000004";
const GRANT = "50000000-0000-4000-8000-000000000005";
const RUN_1 = "60000000-0000-4000-8000-000000000006";
const RUN_2 = "70000000-0000-4000-8000-000000000007";
const executor = {} as Db;
const binding = { boardId: "PVT_board", boardUrl: "https://github.com/orgs/example/projects/1", connectionId: GRANT,
  accountId: 1001, login: "synthetic" };
const hex = (seed: string) => boardImportDigest(seed);

function intent(index: number): BoardImportIntent {
  const task = { title: `Item ${index}`, sourceUrl: `https://github.com/example/repo/issues/${index}`, status: "backlog",
    assigneeAgentId: null, assigneeUserId: null, noDispatch: true };
  return { operationId: hex(`op-${index}`), boardItemId: `item_${index}`, membershipKey: `membership-${index}`,
    companyId: COMPANY, projectId: PROJECT, boardId: binding.boardId, githubIssueNodeId: `issue_${index}`,
    boardUrl: binding.boardUrl, sourceUpdatedAt: "2026-11-01T00:00:00.000Z", fields: {}, task } as unknown as BoardImportIntent;
}
function receipt(value: BoardImportIntent): BoardImportReceipt {
  return { operationId: value.operationId, task: { ...value.task, id: `task-${value.boardItemId}` },
    membership: { key: value.membershipKey, companyId: value.companyId, projectId: value.projectId, boardId: value.boardId,
      boardItemId: value.boardItemId, githubIssueNodeId: value.githubIssueNodeId, taskId: `task-${value.boardItemId}`,
      boardUrl: value.boardUrl, sourceUpdatedAt: value.sourceUpdatedAt, fields: value.fields },
    createdTask: true } as unknown as BoardImportReceipt;
}
function planOf(options: { items?: number; snapshot?: string; authorization?: string; grantRevision?: number } = {}): ScheduledBoardProgressPlan {
  const items = options.items ?? 3;
  return { metadata: { pluginId: PLUGIN, companyId: COMPANY, projectId: PROJECT, jobId: JOB, boardId: binding.boardId,
    boardUrl: binding.boardUrl, bindingDigest: boardImportDigest(binding), authorizationDigest: options.authorization ?? hex("auth-1"),
    grantId: GRANT, grantRevision: options.grantRevision ?? 1, snapshotDigest: options.snapshot ?? hex("snapshot-1"),
    totalCount: items, eligibleCount: items }, intents: Array.from({ length: items }, (_, index) => intent(index + 1)) };
}
function verifiedFor(plan: ScheduledBoardProgressPlan, jobRunId: string, epoch: string): Readonly<VerifiedScheduledBoard> {
  return { target: { pluginId: PLUGIN, companyId: COMPANY, projectId: PROJECT, jobId: JOB, jobRunId }, binding: binding as never,
    authorizationDigest: plan.metadata.authorizationDigest,
    owner: { grantId: plan.metadata.grantId, grantRevision: plan.metadata.grantRevision, preparedByJobRunId: jobRunId, ownerEpoch: epoch },
    grantedByUserId: "user-1", leaseRevision: 1, actorId: "native-actor", maxItems: 20, deadlineMs: Date.now() + 60_000 };
}

describe("scheduled board progress", () => {
  const service = scheduledBoardProgressService({ pluginId: PLUGIN });
  beforeEach(() => stored.clear());

  /** Run 1 verifies `done` items of `plan`, then fails and holds the checkpoint. */
  async function failedRun(plan: ScheduledBoardProgressPlan, done: number) {
    const verified = verifiedFor(plan, RUN_1, "epoch-one");
    let progress = await service.prepare(executor, plan, verified);
    for (let index = 0; index < done; index++) {
      progress = await service.advance(executor, progress, plan, plan.intents[index]!, receipt(plan.intents[index]!), verified);
    }
    return service.hold(executor, progress, plan, verified);
  }

  it("starts a new snapshot at index 0", async () => {
    const plan = planOf();
    const progress = await service.prepare(executor, plan, verifiedFor(plan, RUN_1, "epoch-one"));
    expect(progress).toMatchObject({ nextIndex: 0, phase: "pending", resetReason: "new" });
    expect(selectScheduledBoardProgressBatch(plan, progress, 20).map(item => item.boardItemId)).toEqual(["item_1", "item_2", "item_3"]);
  });

  it("after a failed run resumes from the recorded index, not 0, for the same snapshot", async () => {
    const plan = planOf();
    const held = await failedRun(plan, 2);
    expect(held).toMatchObject({ nextIndex: 2, phase: "held", nativeReceiptCheckpoints: 2 });

    const next = await service.prepare(executor, plan, verifiedFor(plan, RUN_2, "epoch-two"));
    expect(next.nextIndex).toBe(2);
    expect(next.revision).toBe(held.revision);
    expect(selectScheduledBoardProgressBatch(plan, next, 20).map(item => item.boardItemId)).toEqual(["item_3"]);
    expect(summarizeScheduledBoardProgress(next)).toMatchObject({ verifiedForSnapshot: 2, pendingForSnapshot: 1, boardComplete: false });
  });

  it("limits a batch to maxItems from the recorded index", async () => {
    const plan = planOf({ items: 5 });
    const held = await failedRun(plan, 1);
    expect(selectScheduledBoardProgressBatch(plan, held, 2).map(item => item.boardItemId)).toEqual(["item_2", "item_3"]);
  });

  it("resets to 0 with reason source-changed when the snapshot digest changed", async () => {
    await failedRun(planOf(), 2);
    const changed = planOf({ snapshot: hex("snapshot-2") });
    const next = await service.prepare(executor, changed, verifiedFor(changed, RUN_2, "epoch-two"));
    expect(next).toMatchObject({ nextIndex: 0, phase: "pending", resetReason: "source-changed", snapshotDigest: changed.metadata.snapshotDigest });
    expect(next.nativeReceiptCheckpoints).toBe(0);
  });

  it("resets with reason authorization-changed when the authorization digest changed", async () => {
    await failedRun(planOf(), 2);
    const changed = planOf({ snapshot: hex("snapshot-2"), authorization: hex("auth-2") });
    const next = await service.prepare(executor, changed, verifiedFor(changed, RUN_2, "epoch-two"));
    expect(next).toMatchObject({ nextIndex: 0, resetReason: "authorization-changed" });
  });

  it("resets with reason grant-changed when the grant revision changed", async () => {
    await failedRun(planOf(), 1);
    const changed = planOf({ snapshot: hex("snapshot-2"), grantRevision: 2 });
    const next = await service.prepare(executor, changed, verifiedFor(changed, RUN_2, "epoch-two"));
    expect(next).toMatchObject({ nextIndex: 0, resetReason: "grant-changed" });
  });

  it("starts a new pass (index 0, reason new-pass) once the same snapshot was completed", async () => {
    const plan = planOf({ items: 2 });
    const verified = verifiedFor(plan, RUN_1, "epoch-one");
    let progress = await service.prepare(executor, plan, verified);
    for (const item of plan.intents) progress = await service.advance(executor, progress, plan, item, receipt(item), verified);
    expect(progress).toMatchObject({ nextIndex: 2, phase: "complete" });
    expect(summarizeScheduledBoardProgress(progress).boardComplete).toBe(true);

    const again = await service.prepare(executor, plan, verifiedFor(plan, RUN_2, "epoch-two"));
    expect(again).toMatchObject({ nextIndex: 0, phase: "pending", resetReason: "new-pass" });
  });

  it("refuses to skip an item or to advance with a receipt that does not match", async () => {
    const plan = planOf();
    const verified = verifiedFor(plan, RUN_1, "epoch-one");
    const progress = await service.prepare(executor, plan, verified);
    await expect(service.advance(executor, progress, plan, plan.intents[1]!, receipt(plan.intents[1]!), verified))
      .rejects.toThrow(/skip/);
    const wrong = { ...receipt(plan.intents[0]!), operationId: hex("other") } as BoardImportReceipt;
    await expect(service.advance(executor, progress, plan, plan.intents[0]!, wrong, verified)).rejects.toThrow(/receipt/);
  });

  it("refuses a batch for a different snapshot than the recorded progress", async () => {
    const plan = planOf();
    const progress = await service.prepare(executor, plan, verifiedFor(plan, RUN_1, "epoch-one"));
    expect(() => selectScheduledBoardProgressBatch(planOf({ snapshot: hex("snapshot-2") }), progress, 20)).toThrow(/Exact complete/);
    expect(() => selectScheduledBoardProgressBatch(plan, progress, 21)).toThrow(/twenty-item/);
  });

  it("refuses a plan that differs from the current verified native scope", async () => {
    const plan = planOf();
    const other = planOf({ authorization: hex("auth-2") });
    await expect(service.prepare(executor, plan, verifiedFor(other, RUN_1, "epoch-one"))).rejects.toThrow(/differs from current verified/);
  });

  it("keeps the record in the company-scoped progress key", async () => {
    const plan = planOf();
    await service.prepare(executor, plan, verifiedFor(plan, RUN_1, "epoch-one"));
    expect([...stored.keys()]).toEqual([[PLUGIN, "company", COMPANY, GITHUB_PROJECT_BINDING_NAMESPACE, `schedule-progress:${PROJECT}`].join("|")]);
  });
});
