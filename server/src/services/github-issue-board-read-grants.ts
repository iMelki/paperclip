import { updateGitHubIssueMirror, type GitHubIssueIdentity, type GitHubMirrorRead,
  type GitHubProjectCard, type GitHubProjectObservation } from "@paperclipai/shared/github-issue-project-mirror";

export interface GitHubMirrorReadScope {
  companyId: string;
  paperclipProjectId: string;
  paperclipIssueId: string;
  objectId: string;
  userId: string;
}

export interface GitHubBoardReadGrant {
  grantId: string;
  companyId: string;
  paperclipProjectId: string;
  userId: string;
  projectId: string;
  projectUrl: string;
  connectionId: string;
  authorizationRevision: string;
}

type BoardStatus = "fresh" | "partial" | "stale" | "unavailable";
type BoardResult = { projectId: string; state: BoardStatus; card: GitHubProjectCard | null };

type ReadResult =
  | { state: "denied" }
  | { state: "readable"; boards: BoardResult[]; accessRequired: boolean; truncated: boolean };

interface MirrorReader {
  canReadIssue(scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity): Promise<boolean>;
  /** Read issue eligibility and all current grants in one authoritative snapshot. */
  finalAuthorization(scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity, projectIds: readonly string[]): Promise<{
    issueReadable: boolean;
    grants: ReadonlyMap<string, GitHubBoardReadGrant>;
  }>;
  currentGrant(scope: GitHubMirrorReadScope, projectId: string): Promise<GitHubBoardReadGrant | null>;
  retained(scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity, grant: GitHubBoardReadGrant): Promise<GitHubProjectCard | null>;
  read(scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity, grant: GitHubBoardReadGrant, deadline: number): Promise<GitHubProjectObservation>;
}

const idPattern = /^[A-Za-z0-9_=-]{1,256}$/;
const maxBoards = 20;

function matchesScope(grant: GitHubBoardReadGrant | null, scope: GitHubMirrorReadScope,
  projectId: string): grant is GitHubBoardReadGrant {
  return !!grant && grant.companyId === scope.companyId && grant.paperclipProjectId === scope.paperclipProjectId
    && grant.userId === scope.userId && grant.projectId === projectId && !!grant.connectionId
    && /^[a-f0-9-]{36}$/i.test(grant.grantId)
    && /^[a-f0-9]{64}$/.test(grant.authorizationRevision);
}

function sameGrant(before: GitHubBoardReadGrant, after: GitHubBoardReadGrant | null,
  scope: GitHubMirrorReadScope, projectId: string) {
  return matchesScope(after, scope, projectId) && after.connectionId === before.connectionId
    && after.grantId === before.grantId && after.projectUrl === before.projectUrl && after.authorizationRevision === before.authorizationRevision;
}

function retainedForGrant(card: GitHubProjectCard | null, grant: GitHubBoardReadGrant) {
  return card?.projectId === grant.projectId && card.url === grant.projectUrl
    && card.authorizationRevision === grant.authorizationRevision ? card : null;
}

/**
 * Private read-only projection. Project IDs may come from discovery or previously
 * saved exact grants. A missing discovery item cannot attest removal. The host
 * must authoritatively resolve each independent grant and partition retained cards.
 */
export async function readGitHubIssueBoards(
  scope: GitHubMirrorReadScope,
  issue: GitHubIssueIdentity,
  projectIds: readonly string[],
  reader: MirrorReader,
  now = Date.now,
): Promise<ReadResult> {
  if (!(await reader.canReadIssue(scope, issue))) return { state: "denied" };
  const deadline = now() + 20_000;
  const targets = [...new Set(projectIds.filter(id => idPattern.test(id)))];
  const results: Array<{ grant: GitHubBoardReadGrant; result: BoardResult }> = [];
  let accessRequired = false;
  let truncated = targets.length > maxBoards;

  for (const projectId of targets.slice(0, maxBoards)) {
    if (now() >= deadline) {
      truncated = true;
      break;
    }
    const grant = await reader.currentGrant(scope, projectId);
    if (!matchesScope(grant, scope, projectId)) {
      accessRequired = true;
      continue;
    }
    const pinned = { ...grant };
    const previous = { issue, projects: [retainedForGrant(await reader.retained(scope, issue, pinned), pinned)]
      .filter((card): card is GitHubProjectCard => card !== null) };
    const projection: GitHubMirrorRead = now() >= deadline
      ? { state: "partial", mirror: previous }
      : await observe(reader, scope, issue, pinned, previous, deadline, now);
    if (projection.state === "denied") {
      accessRequired = true;
      continue;
    }
    results.push({ grant: pinned, result: { projectId, state: projection.state,
      card: projection.mirror.projects.find(card => card.projectId === projectId) ?? null } });
  }

  const final = await reader.finalAuthorization(scope, issue, results.map(row => row.grant.projectId));
  if (!final.issueReadable) return { state: "denied" };
  const boards: BoardResult[] = [];
  for (const { grant, result } of results) {
    if (sameGrant(grant, final.grants.get(result.projectId) ?? null, scope, result.projectId)) {
      boards.push(result);
    } else {
      accessRequired = true;
    }
  }
  return { state: "readable", boards, accessRequired, truncated };
}

async function observe(reader: MirrorReader, scope: GitHubMirrorReadScope, issue: GitHubIssueIdentity,
  grant: GitHubBoardReadGrant, previous: GitHubMirrorRead["mirror"], deadline: number, now: () => number): Promise<GitHubMirrorRead> {
  const observation = await reader.read(scope, issue, grant, deadline);
  if (observation.state === "denied") return { state: "denied", mirror: { issue, projects: [] } };
  if (now() >= deadline) return { state: "partial", mirror: previous };
  if (observation.state === "readable" && (observation.projectId !== grant.projectId
    || observation.url !== grant.projectUrl || observation.authorizationRevision !== grant.authorizationRevision)) {
    return { state: "denied", mirror: { issue, projects: [] } };
  }
  return updateGitHubIssueMirror(previous, observation, now());
}
