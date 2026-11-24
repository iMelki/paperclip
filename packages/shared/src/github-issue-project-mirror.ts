export type GitHubProjectField = {
  fieldId: string;
  valueId: string;
  name: string;
} & (
  | { kind: "text" | "date"; value: string }
  | { kind: "number"; value: number }
  | { kind: "singleSelect"; value: string; optionId: string }
);

export interface GitHubIssueIdentity {
  nodeId: string;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
}

export interface GitHubProjectCard {
  projectId: string;
  itemId: string;
  title: string;
  url: string;
  revision: string;
  observedAt: number;
  authorizationRevision: string;
  state: "present" | "archived" | "removed";
  fields: readonly GitHubProjectField[];
}

export interface GitHubIssueMirror {
  issue: GitHubIssueIdentity;
  projects: readonly GitHubProjectCard[];
}

interface ProjectPage {
  projectId: string;
  revision: string;
  totalCount: number;
  after: string | null;
  next: string | null;
  items: readonly {
    id: string;
    issueNodeId: string | null;
    archived: boolean;
    redacted: boolean;
    fields: readonly GitHubProjectField[];
  }[];
}

export type GitHubProjectObservation =
  | { state: "denied" | "unavailable" }
  | {
      state: "readable";
      projectId: string;
      title: string;
      url: string;
      observedAt: number;
      authorizationRevision: string;
      pages: readonly ProjectPage[];
    };

export type GitHubMirrorRead = {
  state: "fresh" | "partial" | "stale" | "denied" | "unavailable";
  mirror: GitHubIssueMirror;
  coverage?: "bound_project" | "access_required" | "registered_projects";
  additionalAccessRequired?: boolean;
  accessRequired?: boolean;
  boardReadStates?: readonly { projectId: string; state: "fresh" | "partial" | "stale" | "unavailable" }[];
  checkedProject?: { projectId: string; itemId: string; issueNodeId: string; authorizationRevision: string; observedAt: number };
};

const maxAgeMs = 5 * 60_000;
const maxPages = 20;
const maxItems = 1000;
const authorization = /^[a-f0-9]{64}$/;
const gitHubId = /^[A-Za-z0-9_=-]{1,256}$/;

function completeMembershipRead(
  observation: Extract<GitHubProjectObservation, { state: "readable" }>,
  issue: GitHubIssueIdentity,
) {
  const initial = observation.pages[0];
  if (!initial || observation.pages.length > maxPages || !Number.isSafeInteger(initial.totalCount)
    || initial.totalCount < 0 || initial.totalCount > maxItems) return null;

  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let match: ProjectPage["items"][number] | undefined;
  for (const [index, page] of observation.pages.entries()) {
    if (page.projectId !== observation.projectId || page.revision !== initial.revision
      || page.totalCount !== initial.totalCount || page.after !== cursor
      || (page.next === null) !== (index === observation.pages.length - 1)
      || (page.next !== null && (!page.next.trim() || page.next.length > 512 || cursors.has(page.next)))) return null;
    if (page.next !== null) cursors.add(page.next);
    for (const item of page.items) {
      if (item.redacted || !gitHubId.test(item.id) || seen.has(item.id) || seen.size >= maxItems) return null;
      seen.add(item.id);
      if (item.issueNodeId === issue.nodeId) {
        if (match || new Set(item.fields.map(field => field.fieldId)).size !== item.fields.length) return null;
        match = item;
      }
    }
    cursor = page.next;
  }
  return seen.size === initial.totalCount ? { match, seen, revision: initial.revision } : null;
}

/** Read-side projection. Does not accept a Paperclip task, write authority, or dispatch callback. */
export function updateGitHubIssueMirror(
  mirror: GitHubIssueMirror,
  read: GitHubProjectObservation,
  now: number,
): GitHubMirrorRead {
  if (read.state !== "readable") return { state: read.state, mirror };
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(read.observedAt) || read.observedAt > now
    || now - read.observedAt > maxAgeMs) return { state: "stale", mirror };

  const project = mirror.projects.find(card => card.projectId === read.projectId);
  if (!authorization.test(read.authorizationRevision) || (project && project.authorizationRevision !== read.authorizationRevision)) {
    return { state: "denied", mirror };
  }
  const complete = completeMembershipRead(read, mirror.issue);
  const revision = complete ? Date.parse(complete.revision) : Number.NaN;
  if (!complete || !Number.isFinite(revision)) return { state: "partial", mirror };
  if (project && (read.observedAt < project.observedAt || revision < Date.parse(project.revision))) {
    return { state: "stale", mirror };
  }

  const item = complete.match;
  if (!item) {
    // An occupied/redacted or unadvanced source cannot attest a deletion.
    if (!project) return { state: "fresh", mirror };
    if (complete.seen.has(project.itemId) || revision <= Date.parse(project.revision)) {
      return { state: "partial", mirror };
    }
    return { state: "fresh", mirror: { ...mirror, projects: mirror.projects.map(card => card === project
      ? { ...card, state: "removed", observedAt: read.observedAt, revision: complete.revision }
      : card) } };
  }
  if (project && project.itemId !== item.id && revision <= Date.parse(project.revision)) {
    return { state: "partial", mirror };
  }
  const card: GitHubProjectCard = {
    projectId: read.projectId, itemId: item.id, title: read.title, url: read.url, revision: complete.revision,
    observedAt: read.observedAt, authorizationRevision: read.authorizationRevision, state: item.archived ? "archived" : "present", fields: item.fields,
  };
  return { state: "fresh", checkedProject: { projectId: card.projectId, itemId: card.itemId, issueNodeId: mirror.issue.nodeId,
    authorizationRevision: card.authorizationRevision, observedAt: card.observedAt }, mirror: { ...mirror, projects: [
    ...mirror.projects.filter(previous => previous.projectId !== read.projectId), card,
  ] } };
}

export interface SelectedGitHubProjectFieldEdit {
  issueNodeId: string;
  projectId: string;
  itemId: string;
  fieldId: string;
  expectedValueId: string;
  expectedValue: string;
  expectedRevision: string;
  expectedAuthorizationRevision: string;
  text: string;
}

export function validateSelectedGitHubProjectFieldEdit(
  selected: SelectedGitHubProjectFieldEdit,
  latest: GitHubMirrorRead,
  now: number,
): "precondition-matched" | "refresh-required" | "conflict" {
  const checked = latest.checkedProject;
  if (latest.state !== "fresh" || !checked || checked.projectId !== selected.projectId
    || checked.itemId !== selected.itemId || checked.issueNodeId !== selected.issueNodeId
    || checked.authorizationRevision !== selected.expectedAuthorizationRevision
    || !Number.isSafeInteger(now) || checked.observedAt > now || now - checked.observedAt > maxAgeMs) {
    return "refresh-required";
  }
  if (selected.issueNodeId !== latest.mirror.issue.nodeId) return "conflict";
  const card = latest.mirror.projects.find(row => row.projectId === selected.projectId);
  const field = card?.fields.find(row => row.fieldId === selected.fieldId);
  return card?.state === "present" && card.itemId === selected.itemId && card.revision === selected.expectedRevision
    && card.observedAt === checked.observedAt && card.authorizationRevision === checked.authorizationRevision
    && field?.kind === "text" && field.valueId === selected.expectedValueId && field.value === selected.expectedValue
    && typeof selected.text === "string" && selected.text.length <= 4096
    ? "precondition-matched" : "conflict";
}
