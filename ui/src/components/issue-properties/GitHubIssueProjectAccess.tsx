import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { externalObjectsApi } from "../../api/externalObjects";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { GitHubIssueProjectCards } from "./GitHubIssueProjectCards";
import type { GitHubMirrorRead } from "@paperclipai/shared/github-issue-project-mirror";

export function GitHubIssueProjectAccess({ issueId, objectId, read, refresh }: {
  issueId: string; objectId: string; read?: GitHubMirrorRead; refresh: () => void;
}) {
  const [boardUrl, setBoardUrl] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const list = useMutation({ retry: false, mutationFn: () => externalObjectsApi.listGitHubBoardReadConnections(issueId, objectId) });
  const saved = useMutation({ retry: false, mutationFn: () => externalObjectsApi.listSavedGitHubBoardReadGrants(issueId, objectId) });
  const change = useMutation({
    retry: false,
    mutationFn: (action: Parameters<typeof externalObjectsApi.changeGitHubBoardReadAccess>[2]) =>
      externalObjectsApi.changeGitHubBoardReadAccess(issueId, objectId, action),
    onSuccess: () => { if (saved.isSuccess) saved.mutate(); refresh(); },
  });
  return (
    <div className="space-y-2">
      {read ? <GitHubIssueProjectCards read={read} /> : null}
      <Button size="sm" variant="outline" disabled={saved.isPending || change.isPending} onClick={() => saved.mutate()}>
        Manage saved access
      </Button>
      {saved.isError ? <p role="status">Saved Project access could not be read.</p> : null}
      {saved.isSuccess && !saved.data.grants.length ? <p role="status">No saved Project read access.</p> : null}
      {saved.isSuccess ? (
        <ul className="space-y-1" aria-label="Saved GitHub Project read access">
          {saved.data.grants.map(({ projectId, grantId }) => (
            <li key={grantId} className="flex items-center justify-between gap-2">
              <span className="break-all text-xs">Project ID {projectId}</span>
              <Button size="sm" variant="outline" disabled={change.isPending}
                aria-label={"Remove read access for " + projectId}
                onClick={() => change.mutate({ op: "revoke", projectId, expectedGrantId: grantId })}>Remove read access</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button size="sm" variant="outline" disabled={list.isPending} onClick={() => list.mutate()}>
        Add GitHub Project
      </Button>
      {list.isError ? <p role="status">GitHub connections could not be checked.</p> : null}
      {list.data?.connections.length === 0 ? <p role="status">Reconnect GitHub as the signed-in user to add a Project.</p> : null}
      {list.data?.connections.length ? (
        <form className="space-y-2" onSubmit={event => {
          event.preventDefault();
          if (connectionId && boardUrl.trim() && !change.isPending) {
            change.mutate({ op: "register", connectionId, boardUrl: boardUrl.trim() });
          }
        }}>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger aria-label="GitHub connection"><SelectValue placeholder="Select GitHub connection" /></SelectTrigger>
            <SelectContent>{list.data.connections.map(connection =>
              <SelectItem key={connection.connectionId} value={connection.connectionId}>{connection.name}</SelectItem>
            )}</SelectContent>
          </Select>
          <Input type="url" aria-label="GitHub Project URL" placeholder="GitHub Project URL"
            value={boardUrl} onChange={event => setBoardUrl(event.target.value)} required />
          <Button type="submit" size="sm" disabled={!connectionId || change.isPending}>Register read access</Button>
        </form>
      ) : null}
      {change.isError ? <p role="status">Project access could not be changed. Refresh and check your GitHub connection.</p> : null}
      {change.isSuccess ? <p role="status">{change.variables.op === "register"
        ? "Project read access registered." : "Project read access removed."}</p> : null}
    </div>
  );
}
