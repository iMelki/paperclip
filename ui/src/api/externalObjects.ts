import type { GitHubMirrorRead } from "@paperclipai/shared/github-issue-project-mirror";
import type { ExternalObjectMentionGroup, ExternalObjectSummary } from "@paperclipai/shared";
import { api } from "./client";

export const externalObjectsApi = {
  listForIssue: (issueId: string) =>
    api.get<ExternalObjectMentionGroup[]>(`/issues/${issueId}/external-objects`),
  getIssueSummary: (issueId: string) =>
    api.get<ExternalObjectSummary>(`/issues/${issueId}/external-object-summary`),
  getIssueSummaries: (companyId: string, issueIds: string[]) =>
    api.post<{ summaries: Record<string, ExternalObjectSummary> }>(
      `/companies/${companyId}/issues/external-object-summaries`,
      { issueIds },
    ),
  refreshIssueObjects: (issueId: string, data?: { objectIds?: string[] }) =>
    api.post<{ refreshed: Array<{ object: { id: string }; reason: string }> }>(`/issues/${issueId}/external-objects/refresh`, data ?? {}),
  refreshGitHubProjectMirror: (issueId: string, objectId: string) =>
    api.post<GitHubMirrorRead>(`/issues/${issueId}/github-project-mirror`, { objectId }),
  listGitHubBoardReadConnections: (issueId: string, objectId: string) =>
    api.post<{ connections: { connectionId: string; name: string }[] }>(
      "/issues/" + issueId + "/github-project-access", { objectId, action: { op: "list" } }),
  listSavedGitHubBoardReadGrants: (issueId: string, objectId: string) =>
    api.post<{ grants: { projectId: string; grantId: string }[] }>(
      "/issues/" + issueId + "/github-project-access", { objectId, action: { op: "saved" } }),
  changeGitHubBoardReadAccess: (issueId: string, objectId: string,
    action: { op: "register"; connectionId: string; boardUrl: string }
      | { op: "revoke"; projectId: string; expectedGrantId: string }) =>
    api.post<{ projectId: string }>("/issues/" + issueId + "/github-project-access", { objectId, action }),
  getProjectSummary: (projectId: string) =>
    api.get<ExternalObjectSummary>(`/projects/${projectId}/external-object-summary`),
};
