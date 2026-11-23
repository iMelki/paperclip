import type { GitHubProjectField, GitHubProjectObservation } from "@paperclipai/shared/github-issue-project-mirror";
import { checkedGitHubProjectPage, type GitHubProjectPageInput } from "./github-oauth-project-page.js";

type Readable = Extract<GitHubProjectObservation, { state: "readable" }>;
type ProjectPage = Readable["pages"][number];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const requiredString = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Incomplete GitHub Project metadata");
  return value;
};
const nodeId = (value: unknown) => {
  const id = requiredString(value, 256);
  if (!/^[A-Za-z0-9_=-]{1,256}$/.test(id)) throw new Error("Invalid GitHub Project identity");
  return id;
};

function customField(value: unknown): GitHubProjectField[] {
  const row = record(value);
  const kinds = {
    ProjectV2ItemFieldTextValue: "text",
    ProjectV2ItemFieldNumberValue: "number",
    ProjectV2ItemFieldDateValue: "date",
    ProjectV2ItemFieldSingleSelectValue: "singleSelect",
  } as const;
  const kind = typeof row.__typename === "string" && Object.hasOwn(kinds, row.__typename)
    ? kinds[row.__typename as keyof typeof kinds] : undefined;
  if (!kind) return [];
  const field = record(row.field);
  const id = { fieldId: nodeId(field.id), valueId: nodeId(row.id), name: requiredString(field.name, 128) };
  if (kind === "number") {
    if (typeof row.number !== "number" || !Number.isFinite(row.number)) throw new Error("Invalid GitHub Project number");
    return [{ ...id, kind, value: row.number }];
  }
  if (kind === "singleSelect") return [{ ...id, kind, value: requiredString(row.name, 4096), optionId: nodeId(row.optionId) }];
  if (kind === "text") {
    if (typeof row.text !== "string" || row.text.length > 4096) throw new Error("Invalid GitHub Project text");
    return [{ ...id, kind, value: row.text }];
  }
  return [{ ...id, kind, value: requiredString(row.date, 32) }];
}

export function readGitHubIssueProjectMirrorPage(
  data: unknown, input: GitHubProjectPageInput, issueNodeId: string,
): { title: string; url: string; page: ProjectPage } {
  const { board } = checkedGitHubProjectPage(data, input);
  const items = record(record(record(record(data)[input.ownerType]).projectV2).items);
  const paging = record(items.pageInfo);
  const page: ProjectPage = {
    projectId: board.id, revision: board.updatedAt, totalCount: items.totalCount as number, after: input.after,
    next: paging.hasNextPage === true ? paging.endCursor as string : null,
    items: (items.nodes as unknown[]).map(value => {
      const row = record(value), content = record(row.content);
      const kind = content.__typename;
      const redacted = !["Issue", "PullRequest", "DraftIssue"].includes(String(kind));
      const issueId = kind === "Issue" ? nodeId(content.id) : null;
      return { id: nodeId(row.id), issueNodeId: issueId, archived: row.isArchived as boolean, redacted,
        fields: issueId === issueNodeId ? (record(row.fieldValues).nodes as unknown[]).flatMap(customField) : [] };
    }),
  };
  return { title: board.title, url: board.url, page };
}
