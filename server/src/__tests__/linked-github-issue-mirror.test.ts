import { describe, expect, it } from "vitest";
import type { GitHubMirrorRead, GitHubProjectCard } from "@paperclipai/shared/github-issue-project-mirror";
import { findLinkedGitHubMirrorIssue, mergeBoundAndRegisteredMirrors } from "../services/linked-github-issue-mirror.js";

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

describe("mergeBoundAndRegisteredMirrors", () => {
  const issue = { nodeId: "I_synthetic", url: "https://github.com/example/repo/issues/7", title: "T", state: "OPEN" as const };
  const card = (projectId: string): GitHubProjectCard => ({ projectId, itemId: "PVTI_1", title: projectId, url: "https://github.com/users/example/projects/1",
    revision: "2026-01-01T00:00:00.000Z", observedAt: 1, authorizationRevision: "a".repeat(64), state: "present", fields: [] });
  const read = (state: GitHubMirrorRead["state"], ...projects: string[]): GitHubMirrorRead =>
    ({ state, mirror: { issue, projects: projects.map(card) } });

  it("shows the bound board next to the registered ones", () => {
    const merged = mergeBoundAndRegisteredMirrors(read("fresh", "PVT_bound"), { ...read("fresh", "PVT_other"), accessRequired: false,
      boardReadStates: [{ projectId: "PVT_other", state: "fresh" }] });
    expect(merged.mirror.projects.map(row => row.projectId)).toEqual(["PVT_bound", "PVT_other"]);
    expect(merged.state).toBe("fresh");
    expect(merged.accessRequired).toBe(false);
  });

  it("keeps the bound board when the user has an empty read catalog", () => {
    const merged = mergeBoundAndRegisteredMirrors(read("fresh", "PVT_bound"), { ...read("fresh"), boardReadStates: [] });
    expect(merged.mirror.projects.map(row => row.projectId)).toEqual(["PVT_bound"]);
  });

  it("marks a denied bound board as access required and drops its cards", () => {
    const merged = mergeBoundAndRegisteredMirrors(read("denied", "PVT_bound"), read("fresh", "PVT_other"));
    expect(merged.mirror.projects.map(row => row.projectId)).toEqual(["PVT_other"]);
    expect(merged.accessRequired).toBe(true);
  });

  it("reports an unavailable bound board without access required, and does not repeat a board", () => {
    const merged = mergeBoundAndRegisteredMirrors(read("unavailable", "PVT_bound"), read("fresh", "PVT_bound"));
    expect(merged.mirror.projects.map(row => row.projectId)).toEqual(["PVT_bound"]);
    expect(merged.state).toBe("unavailable");
    expect(merged.accessRequired).toBe(false);
    expect(merged.boardReadStates).toEqual([{ projectId: "PVT_bound", state: "unavailable" }]);
  });
});
