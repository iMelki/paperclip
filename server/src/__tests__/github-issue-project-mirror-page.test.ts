import { describe, expect, it } from "vitest";
import { readGitHubIssueProjectMirrorPage } from "../services/github-issue-project-mirror-page.js";

const input = { ownerType: "organization" as const, owner: "example", number: 1, first: 50, after: null };
const textValue = { __typename: "ProjectV2ItemFieldTextValue", id: "V_text", text: "hello", field: { id: "F_text", name: "Notes" } };
const selectValue = { __typename: "ProjectV2ItemFieldSingleSelectValue", id: "V_sel", name: "Todo", optionId: "O_1", field: { id: "F_sel", name: "Status" } };
const unknownValue = { __typename: "ProjectV2ItemFieldIterationValue", id: "V_it", field: { id: "F_it", name: "Sprint" } };

function data(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return { organization: { projectV2: { id: "PVT_synthetic", title: "Board", url: "https://github.com/orgs/example/projects/1",
    updatedAt: "2026-01-01T00:00:00.000Z", items: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes, ...extra } } } };
}
const item = (id: string, content: Record<string, unknown>, values: unknown[] = []) =>
  ({ id, isArchived: false, content, fieldValues: { pageInfo: { hasNextPage: false }, nodes: values } });

describe("readGitHubIssueProjectMirrorPage", () => {
  it("keeps field values only for the requested issue and ignores unsupported field kinds", () => {
    const result = readGitHubIssueProjectMirrorPage(data([
      item("PVTI_1", { __typename: "Issue", id: "I_target" }, [textValue, selectValue, unknownValue]),
      item("PVTI_2", { __typename: "Issue", id: "I_other" }, [textValue]),
    ]), input, "I_target");
    expect(result.title).toBe("Board");
    const [target, other] = result.page.items;
    expect(target.fields.map(field => field.kind)).toEqual(["text", "singleSelect"]);
    expect(other.fields).toEqual([]);
    expect(result.page.next).toBeNull();
  });

  it("marks items with hidden content as redacted", () => {
    const result = readGitHubIssueProjectMirrorPage(data([item("PVTI_3", { __typename: "Unknown" })]), input, "I_target");
    expect(result.page.items[0]).toMatchObject({ redacted: true, issueNodeId: null });
  });

  it("rejects an incomplete page and an invalid field identity", () => {
    expect(() => readGitHubIssueProjectMirrorPage({ organization: null }, input, "I_target")).toThrow();
    const bad = { ...textValue, id: "bad id!" };
    expect(() => readGitHubIssueProjectMirrorPage(data([item("PVTI_4", { __typename: "Issue", id: "I_target" }, [bad])]), input, "I_target"))
      .toThrow();
  });
});
