import { describe, expect, it } from "vitest";
import { findLinkedGitHubMirrorIssue } from "../services/linked-github-issue-mirror.js";

const COMPANY = "00000000-0000-4000-8000-000000000001";
const OBJECT = "00000000-0000-4000-8000-000000000002";
const object = (over: Record<string, unknown> = {}) => ({
  id: OBJECT, companyId: COMPANY, providerKey: "github", objectType: "issue", liveness: "live",
  sanitizedCanonicalUrl: "https://github.com/example/repo/issues/7",
  data: { nodeId: "I_synthetic", issueTitle: "Synthetic title", state: "open" }, ...over,
});
const find = (value: unknown, objectId = OBJECT, companyId = COMPANY) =>
  findLinkedGitHubMirrorIssue([{ object: value as never }], objectId, companyId);

describe("findLinkedGitHubMirrorIssue", () => {
  it("returns the issue identity for a live linked GitHub issue", () => {
    expect(find(object())).toEqual({ nodeId: "I_synthetic", title: "Synthetic title",
      url: "https://github.com/example/repo/issues/7", state: "OPEN" });
  });

  it("maps a closed issue", () => {
    expect(find(object({ data: { nodeId: "I_synthetic", issueTitle: "T", state: "closed" } }))?.state).toBe("CLOSED");
  });

  it("rejects another company, another object id and non-issue or non-GitHub objects", () => {
    expect(find(object(), OBJECT, "00000000-0000-4000-8000-000000000009")).toBeNull();
    expect(find(object(), "00000000-0000-4000-8000-000000000009")).toBeNull();
    expect(find(object({ objectType: "pull_request" }))).toBeNull();
    expect(find(object({ providerKey: "other" }))).toBeNull();
  });

  it("rejects unreachable objects, bad URLs and bad node ids", () => {
    expect(find(object({ liveness: "auth_required" }))).toBeNull();
    expect(find(object({ liveness: "unreachable" }))).toBeNull();
    expect(find(object({ sanitizedCanonicalUrl: "https://example.com/example/repo/issues/7" }))).toBeNull();
    expect(find(object({ data: { nodeId: "bad id!", issueTitle: "T", state: "open" } }))).toBeNull();
    expect(find(object({ data: { nodeId: "I_synthetic", issueTitle: "T", state: "merged" } }))).toBeNull();
  });
});
