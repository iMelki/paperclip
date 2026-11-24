import { describe, expect, it } from "vitest";
import { readGitHubIssueBoards, type GitHubBoardReadGrant, type GitHubMirrorReadScope } from "../services/github-issue-board-read-grants.js";
import type { GitHubProjectObservation } from "@paperclipai/shared/github-issue-project-mirror";

const ZERO = "00000000-0000-4000-8000-000000000000";
const scope: GitHubMirrorReadScope = { companyId: ZERO, paperclipProjectId: ZERO, paperclipIssueId: ZERO, objectId: ZERO, userId: "user-example" };
const issue = { nodeId: "I_synthetic", url: "https://github.com/example/repo/issues/1", title: "Synthetic", state: "OPEN" as const };
const AUTH = "a".repeat(64);
const grant = (projectId: string): GitHubBoardReadGrant => ({ grantId: ZERO, companyId: ZERO, paperclipProjectId: ZERO, userId: "user-example",
  projectId, projectUrl: "https://github.com/orgs/example/projects/1", connectionId: ZERO, authorizationRevision: AUTH });
const readable = (projectId: string): GitHubProjectObservation => ({ state: "readable", projectId, title: "Board",
  url: "https://github.com/orgs/example/projects/1", observedAt: Date.now(), authorizationRevision: AUTH,
  pages: [{ projectId, revision: "2026-01-01T00:00:00.000Z", totalCount: 1, after: null, next: null,
    items: [{ id: "PVTI_1", issueNodeId: issue.nodeId, archived: false, redacted: false, fields: [] }] }] });

function reader(over: Partial<Parameters<typeof readGitHubIssueBoards>[3]> = {}) {
  const grants = new Map([["PVT_a", grant("PVT_a")]]);
  return {
    canReadIssue: async () => true,
    finalAuthorization: async () => ({ issueReadable: true, grants }),
    currentGrant: async (_s: GitHubMirrorReadScope, id: string) => grants.get(id) ?? null,
    retained: async () => null,
    read: async () => readable("PVT_a"),
    ...over,
  };
}

describe("readGitHubIssueBoards", () => {
  it("fails closed when the issue is not readable", async () => {
    expect(await readGitHubIssueBoards(scope, issue, ["PVT_a"], reader({ canReadIssue: async () => false }))).toEqual({ state: "denied" });
  });

  it("requires access for a board without a saved grant", async () => {
    const result = await readGitHubIssueBoards(scope, issue, ["PVT_none"], reader());
    expect(result).toMatchObject({ state: "readable", boards: [], accessRequired: true });
  });

  it("reads a granted board and returns its card", async () => {
    const result = await readGitHubIssueBoards(scope, issue, ["PVT_a"], reader());
    expect(result.state).toBe("readable");
    if (result.state === "readable") {
      expect(result.boards[0]).toMatchObject({ projectId: "PVT_a", state: "fresh" });
      expect(result.boards[0].card?.itemId).toBe("PVTI_1");
    }
  });

  it("drops a board whose grant disappeared before the final check", async () => {
    const result = await readGitHubIssueBoards(scope, issue, ["PVT_a"],
      reader({ finalAuthorization: async () => ({ issueReadable: true, grants: new Map() }) }));
    expect(result).toMatchObject({ state: "readable", boards: [], accessRequired: true });
  });

  it("denies when the issue stops being readable at the final check", async () => {
    const result = await readGitHubIssueBoards(scope, issue, ["PVT_a"],
      reader({ finalAuthorization: async () => ({ issueReadable: false, grants: new Map() }) }));
    expect(result).toEqual({ state: "denied" });
  });

  it("treats an observation under another authorization revision as access required", async () => {
    const wrong = { ...readable("PVT_a"), authorizationRevision: "b".repeat(64) } as GitHubProjectObservation;
    const result = await readGitHubIssueBoards(scope, issue, ["PVT_a"], reader({ read: async () => wrong }));
    expect(result).toMatchObject({ boards: [], accessRequired: true });
  });

  it("marks the result truncated beyond twenty boards", async () => {
    const ids = Array.from({ length: 21 }, (_v, i) => `PVT_${i}`);
    const result = await readGitHubIssueBoards(scope, issue, ids, reader());
    expect(result).toMatchObject({ state: "readable", truncated: true });
  });
});
