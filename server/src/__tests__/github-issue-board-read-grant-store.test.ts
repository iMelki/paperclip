import { describe, expect, it } from "vitest";
import { githubBoardReadGrantSchema, githubIssueBoardReadGrantKey } from "../services/github-issue-board-read-grant-store.js";

const ZERO = "00000000-0000-4000-8000-000000000000";
const scope = { companyId: ZERO, paperclipProjectId: ZERO, paperclipIssueId: ZERO, objectId: ZERO, userId: "user-example" };
const grant = {
  version: 1, grantId: ZERO, companyId: ZERO, paperclipProjectId: ZERO, userId: "user-example", projectId: "PVT_synthetic",
  projectUrl: "https://github.com/orgs/example/projects/1", connectionId: ZERO, accountId: 1001, login: "example",
  authorizationRevision: "a".repeat(64),
};

describe("githubIssueBoardReadGrantKey", () => {
  it("is stable and bound to company, project, user and GitHub Project", () => {
    const key = githubIssueBoardReadGrantKey(scope, "PVT_synthetic");
    expect(key).toMatch(/^issue-read-grant-v1:[a-f0-9]{64}$/);
    expect(githubIssueBoardReadGrantKey(scope, "PVT_synthetic")).toBe(key);
    expect(githubIssueBoardReadGrantKey({ ...scope, userId: "someone-else" }, "PVT_synthetic")).not.toBe(key);
    expect(githubIssueBoardReadGrantKey(scope, "PVT_other")).not.toBe(key);
  });

  it("does not depend on the issue or the linked object", () => {
    expect(githubIssueBoardReadGrantKey({ ...scope, paperclipIssueId: "x", objectId: "y" }, "PVT_synthetic"))
      .toBe(githubIssueBoardReadGrantKey(scope, "PVT_synthetic"));
  });
});

describe("githubBoardReadGrantSchema", () => {
  it("accepts a complete grant", () => {
    expect(githubBoardReadGrantSchema.safeParse(grant).success).toBe(true);
  });

  it("rejects unknown fields, a malformed revision and a bad login", () => {
    expect(githubBoardReadGrantSchema.safeParse({ ...grant, extra: true }).success).toBe(false);
    expect(githubBoardReadGrantSchema.safeParse({ ...grant, authorizationRevision: "short" }).success).toBe(false);
    expect(githubBoardReadGrantSchema.safeParse({ ...grant, login: "-bad-" }).success).toBe(false);
    expect(githubBoardReadGrantSchema.safeParse({ ...grant, version: 2 }).success).toBe(false);
  });
});
