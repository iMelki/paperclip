import { describe, expect, it } from "vitest";
import { advanceGitHubProjectAttestation as advanceNative, assertGitHubProjectAttestedIntent as assertNative,
  gitHubProjectAttestedIntentChecker, pendingGitHubProjectAttestation as pendingNative,
  GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS } from "../services/github-project-board-attestation.js";
import { boardImportDigest, validateBoardImportIntent, type BoardImportIntent } from "../services/plugin-imported-issues-contract.js";
import type { GitHubProjectBinding } from "../services/plugin-github-project-board.js";
import type { GitHubProjectPageInput } from "../services/github-oauth-project-page.js";

const binding: GitHubProjectBinding = { version: 1,
  companyId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
  boardId: "PVT_12", boardUrl: "https://github.com/users/example/projects/12",
  connectionId: "33333333-3333-4333-8333-333333333333", accountId: 42, login: "example",
  boundByUserId: "synthetic-operator", boundAt: "2026-10-13T00:00:00Z" };
const page = { ownerType: "user" as const, owner: "example", number: 12, after: null, first: 50 };
const now = Date.parse("2026-10-13T00:00:00Z");
const authority = "a".repeat(64);
const pendingGitHubProjectAttestation = (value: GitHubProjectBinding, timestamp: number) => pendingNative(value, authority, timestamp);
const advanceGitHubProjectAttestation = (previous: ReturnType<typeof pendingNative>, value: GitHubProjectBinding,
  input: GitHubProjectPageInput, result: unknown, timestamp: number) => advanceNative(previous, value, input, result, authority, timestamp);
const assertGitHubProjectAttestedIntent = (value: unknown, target: GitHubProjectBinding,
  requested: BoardImportIntent, timestamp: number) => assertNative(value, target, requested, authority, timestamp);
function item(id = "PVTI_1", kind = "Issue", state = "OPEN", archived = false) {
  return { id, isArchived: archived, content: { __typename: kind, id: "I_1", number: 1,
    title: "Synthetic source title", url: "https://github.com/example/fixture/issues/1", state,
    repository: { nameWithOwner: "example/fixture" } }, fieldValues: {
    pageInfo: { hasNextPage: false }, nodes: [{ name: "ReadyForAgent", field: { name: "Status" } },
      { number: 3, field: { name: "Estimate" } }] } };
}
function data(nodes = [item()], hasNextPage = false, totalCount = nodes.length, cursor: string | null = null) {
  return { user: { projectV2: { id: binding.boardId, url: binding.boardUrl, title: "Synthetic board",
    updatedAt: "2026-10-13T00:00:00Z", items: { totalCount, nodes, pageInfo: { hasNextPage, endCursor: cursor } } } } };
}
function intent(patch: Record<string, unknown> = {}): BoardImportIntent {
  const base = { companyId: binding.companyId, projectId: binding.projectId, boardId: binding.boardId,
    boardUrl: binding.boardUrl, boardItemId: "PVTI_1", githubIssueNodeId: "I_1",
    sourceUpdatedAt: "2026-10-13T00:00:00Z", fields: [{ name: "Status", value: "ReadyForAgent" }, { name: "Estimate", value: "3" }],
    task: { companyId: binding.companyId, projectId: binding.projectId, githubIssueNodeId: "I_1",
      title: "Synthetic source title", sourceUrl: "https://github.com/example/fixture/issues/1",
      status: "backlog" as const, assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const }, ...patch };
  const body = { ...base, taskKey: boardImportDigest(["github-issue", base.companyId, base.githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", base.companyId, base.boardId, base.boardItemId]) };
  const ordered = { companyId: body.companyId, projectId: body.projectId, taskKey: body.taskKey, membershipKey: body.membershipKey,
    boardId: body.boardId, boardItemId: body.boardItemId, githubIssueNodeId: body.githubIssueNodeId, boardUrl: body.boardUrl,
    sourceUpdatedAt: body.sourceUpdatedAt, task: body.task, fields: body.fields };
  const intentHash = boardImportDigest(["board-import-v1", ordered]);
  return { ...ordered, operationId: intentHash, intentHash } as BoardImportIntent;
}
function snapshot(value = data()) {
  return advanceGitHubProjectAttestation(pendingGitHubProjectAttestation(binding, now), binding, page, value, now);
}
describe("host-owned GitHub board attestation", () => {
  it("matches a complete host observed issue and preserves Ready metadata without dispatch", () => {
    const saved = snapshot();
    expect(saved.complete).toBe(true);
    expect(saved.issues[0].fields).toEqual(intent().fields);
    expect(() => assertGitHubProjectAttestedIntent(saved, binding, intent(), now)).not.toThrow();
    expect(saved).not.toHaveProperty("token");
    expect(saved).not.toHaveProperty("assigneeAgentId");
  });
  it("requires every sequential page before permitting import", () => {
    const first = advanceGitHubProjectAttestation(pendingGitHubProjectAttestation(binding, now), binding,
      page, data([item()], true, 2, "cursor2"), now);
    expect(() => assertGitHubProjectAttestedIntent(first, binding, intent(), now)).toThrow("fresh complete");
    const final = advanceGitHubProjectAttestation(first, binding, { ...page, after: "cursor2" },
      data([item("PVTI_2", "DraftIssue")], false, 2), now + 1000);
    expect(final.seenItemIds).toEqual(["PVTI_1", "PVTI_2"]);
    expect(final.issues).toHaveLength(1);
    expect(() => assertGitHubProjectAttestedIntent(final, binding, intent(), now + 1000)).not.toThrow();
  });
  it.each([
    { githubIssueNodeId: "I_arbitrary", task: { ...intent().task, githubIssueNodeId: "I_arbitrary" } },
    { boardItemId: "PVTI_arbitrary" }, { task: { ...intent().task, title: "Forged title" } },
    { task: { ...intent().task, sourceUrl: "https://github.com/example/other/issues/1" } },
    { fields: [{ name: "Status", value: "Ready" }] }, { sourceUpdatedAt: "2026-10-13T00:01:00Z" },
  ])("refuses even a newly recomputed valid-hash changed intent %j", patch => {
    expect(() => validateBoardImportIntent(intent(patch), binding.companyId)).not.toThrow();
    expect(() => assertGitHubProjectAttestedIntent(snapshot(), binding, intent(patch), now)).toThrow();
  });
  it.each(["PullRequest", "DraftIssue"])("does not attest %s as an importable issue", kind => {
    const saved = snapshot(data([item("PVTI_1", kind)]));
    expect(saved.issues).toEqual([]);
    expect(() => assertGitHubProjectAttestedIntent(saved, binding, intent(), now)).toThrow("host-observed");
  });
  it.each([item("PVTI_1", "Issue", "CLOSED"), item("PVTI_1", "Issue", "OPEN", true)])
    ("closed and archived issues are explicitly ineligible", value => {
      const saved = snapshot(data([value]));
      expect(saved.issues).toEqual([]);
      expect(() => assertGitHubProjectAttestedIntent(saved, binding, intent(), now)).toThrow();
    });
  it("refuses missing/stale/future snapshots and account/connection rebinds", () => {
    const saved = snapshot();
    for (const candidate of [null, { ...saved, complete: false }, { ...saved, completedAt: now + 1 }]) {
      expect(() => assertGitHubProjectAttestedIntent(candidate, binding, intent(), now)).toThrow();
    }
    expect(() => assertGitHubProjectAttestedIntent(saved, binding, intent(), now + GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS + 1)).toThrow();
    for (const changed of [{ ...binding, accountId: 43 }, { ...binding, connectionId: binding.projectId }]) {
      expect(() => assertGitHubProjectAttestedIntent(saved, changed, intent(), now)).toThrow();
    }
  });
  it("refuses a changed native authorization revision despite unchanged account and binding", () => {
    expect(() => assertNative(snapshot(), binding, intent(), "b".repeat(64), now)).toThrow("fresh complete");
  });
  it("refuses duplicate source identities even when board item IDs differ", () => {
    expect(() => snapshot(data([item("PVTI_1"), item("PVTI_2")]))).toThrow("Repeated GitHub issue source");
  });
  it("refuses cursor gaps, repeated items, coverage gaps and revision drift", () => {
    const first = advanceGitHubProjectAttestation(pendingGitHubProjectAttestation(binding, now), binding,
      page, data([item()], true, 2, "cursor2"), now);
    expect(() => advanceGitHubProjectAttestation(first, binding, { ...page, after: "wrong" }, data(), now)).toThrow();
    expect(() => advanceGitHubProjectAttestation(first, binding, { ...page, after: "cursor2" }, data([item()], false, 2), now)).toThrow();
    expect(() => snapshot(data([item()], false, 2))).toThrow("coverage");
    const changed = data([item("PVTI_2")], false, 2);
    changed.user.projectV2.updatedAt = "2026-10-13T00:01:00Z";
    expect(() => advanceGitHubProjectAttestation(first, binding, { ...page, after: "cursor2" }, changed, now)).toThrow("changed");
  });
  it("refuses over-cap, over-page, incomplete fields and malformed issue identities", () => {
    expect(() => snapshot(data([item()], true, 1001, "cursor2"))).toThrow("bounded");
    expect(() => advanceGitHubProjectAttestation({ ...pendingGitHubProjectAttestation(binding, now), pages: 20 }, binding, page, data(), now)).toThrow();
    const incomplete = item(); incomplete.fieldValues.pageInfo.hasNextPage = true;
    expect(() => snapshot(data([incomplete]))).toThrow();
    const wrong = item(); wrong.content.url = "https://github.com/example/other/issues/1";
    expect(() => snapshot(data([wrong]))).toThrow("identity");
  });
});

describe("attested intent checker over a whole board", () => {
  // A full 1,000-item board, the largest the attestation accepts.
  function fullBoard() {
    const ids = Array.from({ length: 1000 }, (_, index) => `PVTI_${index}`);
    const issues = ids.map((boardItemId, index) => ({ boardItemId, githubIssueNodeId: `I_${index}`,
      title: `Synthetic source title ${index}`, sourceUrl: `https://github.com/example/fixture/issues/${index}`,
      fields: [{ name: "Status", value: "ReadyForAgent" }] }));
    return { version: 1, bindingDigest: boardImportDigest(binding), authorizationDigest: authority,
      companyId: binding.companyId, projectId: binding.projectId, boardId: binding.boardId, boardUrl: binding.boardUrl,
      sourceUpdatedAt: "2026-10-13T00:00:00Z", totalCount: ids.length, startedAt: now, completedAt: now,
      complete: true, pages: 20, nextCursor: null, seenItemIds: ids, issues };
  }
  function boardIntent(index: number, patch: Record<string, unknown> = {}) {
    return intent({ boardItemId: `PVTI_${index}`, githubIssueNodeId: `I_${index}`,
      fields: [{ name: "Status", value: "ReadyForAgent" }],
      task: { companyId: binding.companyId, projectId: binding.projectId, githubIssueNodeId: `I_${index}`,
        title: `Synthetic source title ${index}`, sourceUrl: `https://github.com/example/fixture/issues/${index}`,
        status: "backlog", assigneeAgentId: null, assigneeUserId: null, noDispatch: true }, ...patch });
  }

  it("validates the attestation once and accepts every attested intent", () => {
    const { attestation, assertIntent } = gitHubProjectAttestedIntentChecker(fullBoard(), binding, authority, now);
    expect(attestation.issues).toHaveLength(1000);
    for (let index = 0; index < 1000; index += 1) expect(() => assertIntent(boardIntent(index))).not.toThrow();
  });

  it("rejects an intent that is not on the board or differs from the observed issue", () => {
    const { assertIntent } = gitHubProjectAttestedIntentChecker(fullBoard(), binding, authority, now);
    expect(() => assertIntent(boardIntent(1000))).toThrow("Import intent differs");
    expect(() => assertIntent(boardIntent(7, { githubIssueNodeId: "I_8" }))).toThrow("Import intent differs");
    expect(() => assertIntent(boardIntent(7, { sourceUpdatedAt: "2026-10-14T00:00:00Z" })))
      .toThrow("A fresh complete host-observed board preview");
  });

  it("rejects an issue whose board item was never observed, as the full check does", () => {
    const board = fullBoard();
    board.issues[3] = { ...board.issues[3], boardItemId: "PVTI_missing" };
    expect(() => gitHubProjectAttestedIntentChecker(board, binding, authority, now))
      .toThrow("A fresh complete host-observed board preview");
    expect(() => assertGitHubProjectAttestedIntent(board, binding, boardIntent(0), now))
      .toThrow("A fresh complete host-observed board preview");
  });
});
