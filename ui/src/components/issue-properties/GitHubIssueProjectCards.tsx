import type { GitHubMirrorRead } from "@paperclipai/shared/github-issue-project-mirror";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const membershipLabel = { present: "On project", archived: "Archived", removed: "Removed from project" };
const problemLabel = {
  denied: "GitHub Project access was denied.",
  unavailable: "GitHub Project details are unavailable.",
  partial: "The Project read was incomplete. Showing saved details.",
  stale: "The Project details could not be confirmed as current. Showing saved details.",
};

function safeGitHubLink(value: string, project: boolean) {
  const expected = project
    ? /^https:\/\/github\.com\/(?:users|orgs)\/[A-Za-z0-9-]+\/projects\/[1-9][0-9]*$/
    : /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/;
  return expected.test(value) ? value : undefined;
}

export function GitHubIssueProjectCards({ read }: { read: GitHubMirrorRead }) {
  const { issue, projects } = read.mirror;
  const projectAccess = read.state !== "denied" && read.state !== "unavailable";
  const issueUrl = safeGitHubLink(issue.url, false);

  return (
    <section className="space-y-3" aria-label="GitHub details">
      <Card className="gap-2 py-3">
        <CardHeader className="px-3">
          <CardTitle className="break-words">
            {issueUrl ? <a href={issueUrl} className="hover:underline">{issue.title}</a> : issue.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 text-xs text-muted-foreground">
          {issue.state === "OPEN" ? "Open on GitHub" : "Closed on GitHub"}
        </CardContent>
      </Card>
      {read.state !== "fresh" ? <p className="text-xs text-muted-foreground" role="status">{read.coverage === "access_required" ? "Connect the requested GitHub Project to view its details." : problemLabel[read.state]}</p> : null}
      {read.accessRequired || read.additionalAccessRequired ? (
        <p className="text-xs text-muted-foreground" role="status">Additional GitHub Projects require verified read access.</p>
      ) : null}
      {projectAccess ? projects.map(project => {
        const href = safeGitHubLink(project.url, true);
        const checked = new Date(project.observedAt);
        const boardState = read.boardReadStates?.find(board => board.projectId === project.projectId)?.state;
        return (
          <Card key={project.projectId} className="gap-2 py-3">
            <CardHeader className="px-3">
              <CardTitle className="break-words">
                {href ? <a href={href} className="hover:underline">{project.title}</a> : project.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-3 text-xs">
              <p className="text-muted-foreground">{membershipLabel[project.state]} · Checked <time dateTime={checked.toISOString()}>{checked.toLocaleString()}</time></p>
              {boardState && boardState !== "fresh" ? <p role="status">{problemLabel[boardState]}</p> : null}
              {project.state !== "removed" && project.fields.length ? (
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">
                  {project.fields.map(field => (
                    <div key={field.fieldId} className="contents">
                      <dt className="break-words text-muted-foreground">{field.name}</dt>
                      <dd className="break-words">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </CardContent>
          </Card>
        );
      }) : null}
    </section>
  );
}
