import { describe, expect, it } from "vitest";
import {
  updateGitHubIssueMirror,
  validateSelectedGitHubProjectFieldEdit,
  type GitHubIssueMirror,
  type GitHubProjectObservation,
} from "./github-issue-project-mirror.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const AUTH = "a".repeat(64);
const issue = { nodeId: "I_synthetic", url: "https://github.com/example/repo/issues/1", title: "Synthetic", state: "OPEN" as const };
const empty: GitHubIssueMirror = { issue, projects: [] };
const field = { fieldId: "F_text", valueId: "V_text", name: "Notes", kind: "text" as const, value: "hello" };

function observation(over: { items?: unknown[]; observedAt?: number; auth?: string; revision?: string; totalCount?: number } = {}) {
  const items = (over.items ?? [{ id: "PVTI_1", issueNodeId: issue.nodeId, archived: false, redacted: false, fields: [field] }]) as never[];
  return {
    state: "readable", projectId: "PVT_synthetic", title: "Board", url: "https://github.com/orgs/example/projects/1",
    observedAt: over.observedAt ?? NOW - 1000, authorizationRevision: over.auth ?? AUTH,
    pages: [{ projectId: "PVT_synthetic", revision: over.revision ?? "2026-01-01T11:00:00.000Z",
      totalCount: over.totalCount ?? items.length, after: null, next: null, items }],
  } as GitHubProjectObservation;
}

describe("updateGitHubIssueMirror", () => {
  it("returns the previous mirror unchanged for denied or unavailable reads", () => {
    expect(updateGitHubIssueMirror(empty, { state: "denied" }, NOW)).toEqual({ state: "denied", mirror: empty });
    expect(updateGitHubIssueMirror(empty, { state: "unavailable" }, NOW).state).toBe("unavailable");
  });

  it("stores a fresh card for a complete membership read", () => {
    const read = updateGitHubIssueMirror(empty, observation(), NOW);
    expect(read.state).toBe("fresh");
    expect(read.mirror.projects).toHaveLength(1);
    expect(read.mirror.projects[0]).toMatchObject({ itemId: "PVTI_1", state: "present", fields: [field] });
    expect(read.checkedProject?.issueNodeId).toBe(issue.nodeId);
  });

  it("refuses stale, malformed-authorization and incomplete reads", () => {
    expect(updateGitHubIssueMirror(empty, observation({ observedAt: NOW - 6 * 60_000 }), NOW).state).toBe("stale");
    expect(updateGitHubIssueMirror(empty, observation({ observedAt: NOW + 1 }), NOW).state).toBe("stale");
    expect(updateGitHubIssueMirror(empty, observation({ auth: "not-a-digest" }), NOW).state).toBe("denied");
    expect(updateGitHubIssueMirror(empty, observation({ totalCount: 5 }), NOW).state).toBe("partial");
  });

  it("treats a redacted item as an incomplete read and never as removal", () => {
    const redacted = observation({ items: [{ id: "PVTI_9", issueNodeId: null, archived: false, redacted: true, fields: [] }] });
    expect(updateGitHubIssueMirror(empty, redacted, NOW).state).toBe("partial");
  });

  it("does not mark an item removed when the source revision did not advance", () => {
    const first = updateGitHubIssueMirror(empty, observation(), NOW).mirror;
    const gone = observation({ items: [], revision: "2026-01-01T11:00:00.000Z" });
    expect(updateGitHubIssueMirror(first, gone, NOW).state).toBe("partial");
    const advanced = observation({ items: [], revision: "2026-01-01T11:30:00.000Z" });
    const result = updateGitHubIssueMirror(first, advanced, NOW);
    expect(result.state).toBe("fresh");
    expect(result.mirror.projects[0].state).toBe("removed");
  });

  it("denies a read made under a different authorization revision than the retained card", () => {
    const first = updateGitHubIssueMirror(empty, observation(), NOW).mirror;
    expect(updateGitHubIssueMirror(first, observation({ auth: "b".repeat(64) }), NOW).state).toBe("denied");
  });
});

describe("validateSelectedGitHubProjectFieldEdit", () => {
  const fresh = updateGitHubIssueMirror(empty, observation(), NOW);
  const card = fresh.mirror.projects[0];
  const selected = { issueNodeId: issue.nodeId, projectId: card.projectId, itemId: card.itemId, fieldId: field.fieldId,
    expectedValueId: field.valueId, expectedValue: field.value, expectedRevision: card.revision,
    expectedAuthorizationRevision: AUTH, text: "new" };

  it("matches only the exact checked precondition", () => {
    expect(validateSelectedGitHubProjectFieldEdit(selected, fresh, NOW)).toBe("precondition-matched");
    expect(validateSelectedGitHubProjectFieldEdit({ ...selected, expectedValue: "other" }, fresh, NOW)).toBe("conflict");
    expect(validateSelectedGitHubProjectFieldEdit({ ...selected, text: "x".repeat(4097) }, fresh, NOW)).toBe("conflict");
  });

  it("requires a refresh when the latest read is not fresh or too old", () => {
    expect(validateSelectedGitHubProjectFieldEdit(selected, { ...fresh, state: "partial" }, NOW)).toBe("refresh-required");
    expect(validateSelectedGitHubProjectFieldEdit(selected, fresh, NOW + 10 * 60_000)).toBe("refresh-required");
  });
});
