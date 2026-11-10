import { isDeepStrictEqual } from "node:util";
import { conflict } from "../errors.js";
import { boardImportDigest, type BoardImportIntent } from "./plugin-imported-issues-contract.js";
import { checkedGitHubProjectPage, type GitHubProjectPageInput } from "./github-oauth-project-page.js";
import type { GitHubProjectBinding } from "./plugin-github-project-board.js";

export const GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS = 5 * 60_000;
interface ObservedIssue {
  boardItemId: string; githubIssueNodeId: string; title: string; sourceUrl: string;
  fields: Array<{ name: string; value: string }>;
}
export interface GitHubProjectAttestation {
  version: 1; bindingDigest: string; authorizationDigest: string; companyId: string; projectId: string;
  boardId: string; boardUrl: string; sourceUpdatedAt: string | null; totalCount: number | null;
  startedAt: number; completedAt: number | null; complete: boolean; pages: number;
  nextCursor: string | null; seenItemIds: string[]; issues: ObservedIssue[];
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw conflict("Incomplete observed GitHub board metadata");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw conflict("Incomplete observed GitHub board metadata");
  return value;
};
const node = (value: unknown): string => {
  const id = text(value);
  if (!/^[A-Za-z0-9_=-]{1,256}$/.test(id)) throw conflict("Invalid observed GitHub board identity");
  return id;
};
export function pendingGitHubProjectAttestation(
  binding: GitHubProjectBinding, authorizationDigest: string, now = Date.now(),
): GitHubProjectAttestation {
  if (!/^[a-f0-9]{64}$/.test(authorizationDigest)) throw conflict("Missing native authorization revision");
  return { version: 1, bindingDigest: boardImportDigest(binding), authorizationDigest,
    companyId: binding.companyId, projectId: binding.projectId,
    boardId: binding.boardId, boardUrl: binding.boardUrl, sourceUpdatedAt: null, totalCount: null,
    startedAt: now, completedAt: null, complete: false, pages: 0, nextCursor: null, seenItemIds: [], issues: [] };
}
function normalizedFields(value: unknown): ObservedIssue["fields"] {
  const fields = record(value), info = record(fields.pageInfo);
  if (info.hasNextPage !== false || !Array.isArray(fields.nodes) || fields.nodes.length > 100) {
    throw conflict("Incomplete observed GitHub board fields");
  }
  return fields.nodes.flatMap(value => {
    const field = record(value);
    if (!field.field) return [];
    const name = text(record(field.field).name), content = field.text ?? field.name ?? field.number ?? field.date;
    if (name.length > 128 || typeof content === "string" && content.length > 4096) throw conflict("Oversized observed board field");
    return typeof content === "string" || typeof content === "number" && Number.isFinite(content)
      ? [{ name, value: String(content) }] : [];
  });
}
/** Normalization is aligned with the existing MIT-adapted plugin reader; execution/status fields remain metadata. */
function observedIssue(value: unknown): { id: string; issue: ObservedIssue | null } {
  const item = record(value), id = node(item.id), fields = normalizedFields(item.fieldValues);
  if (typeof item.isArchived !== "boolean") throw conflict("Incomplete observed archive state");
  if (item.isArchived || item.content === null) return { id, issue: null };
  const content = record(item.content);
  if (["PullRequest", "DraftIssue"].includes(String(content.__typename))) {
    text(content.title);
    return { id, issue: null };
  }
  if (content.__typename !== "Issue") throw conflict("Unknown observed GitHub board content type");
  const repository = text(record(content.repository).nameWithOwner), url = text(content.url);
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/);
  if (!match || match[1] !== repository || Number(match[2]) !== content.number
    || !Number.isSafeInteger(content.number) || new URL(url).href !== url
    || !["OPEN", "CLOSED"].includes(String(content.state))) throw conflict("Invalid observed GitHub issue identity");
  const issue = { boardItemId: id, githubIssueNodeId: node(content.id), title: text(content.title), sourceUrl: url, fields };
  return { id, issue: content.state === "OPEN" ? issue : null };
}

export function advanceGitHubProjectAttestation(
  previous: GitHubProjectAttestation, binding: GitHubProjectBinding,
  page: GitHubProjectPageInput, data: unknown, authorizationDigest: string, now = Date.now(),
): GitHubProjectAttestation {
  if (!previous || previous.version !== 1 || previous.bindingDigest !== boardImportDigest(binding)
    || previous.authorizationDigest !== authorizationDigest || previous.companyId !== binding.companyId || previous.projectId !== binding.projectId
    || previous.boardId !== binding.boardId || previous.boardUrl !== binding.boardUrl
    || previous.complete || previous.pages >= 20 || !Number.isSafeInteger(previous.startedAt)
    || now < previous.startedAt || now - previous.startedAt > GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS
    || page.after !== previous.nextCursor) throw conflict("Missing, stale or nonsequential board observation");
  const checked = checkedGitHubProjectPage(data, page), items = record(record(record(data)[page.ownerType]).projectV2).items;
  const listing = record(items), info = record(listing.pageInfo);
  if (checked.board.id !== binding.boardId || checked.board.url !== binding.boardUrl
    || (previous.pages > 0 && (checked.board.updatedAt !== previous.sourceUpdatedAt || listing.totalCount !== previous.totalCount))
    || (listing.totalCount as number) > 1000 || (info.hasNextPage && !(listing.nodes as unknown[]).length)) {
    throw conflict("GitHub board changed or exceeded bounded observation");
  }
  const seenItemIds = [...previous.seenItemIds], issues = [...previous.issues];
  for (const value of listing.nodes as unknown[]) {
    const observed = observedIssue(value);
    if (seenItemIds.includes(observed.id)) throw conflict("Repeated GitHub board item observation");
    seenItemIds.push(observed.id);
    if (observed.issue) {
      if (issues.some(issue => issue.githubIssueNodeId === observed.issue!.githubIssueNodeId
        || issue.sourceUrl === observed.issue!.sourceUrl)) throw conflict("Repeated GitHub issue source observation");
      issues.push(observed.issue);
    }
  }
  const complete = info.hasNextPage === false;
  if (seenItemIds.length > 1000 || seenItemIds.length > (listing.totalCount as number)
    || complete && seenItemIds.length !== listing.totalCount) throw conflict("Incomplete GitHub board item coverage");
  return { ...previous, sourceUpdatedAt: checked.board.updatedAt, totalCount: listing.totalCount as number,
    complete, completedAt: complete ? now : null, pages: previous.pages + 1,
    nextCursor: complete ? null : info.endCursor as string, seenItemIds, issues };
}

export function assertCompleteGitHubProjectAttestation(
  value: unknown, binding: GitHubProjectBinding, authorizationDigest: string, now = Date.now(),
): GitHubProjectAttestation {
  const attestation = record(value) as unknown as GitHubProjectAttestation;
  // One set lookup per issue. `seenItemIds.includes` per issue is quadratic in the
  // board size (up to 1,000 items) and runs while authorization locks are held.
  const seenItemIds = Array.isArray(attestation.seenItemIds) ? new Set<unknown>(attestation.seenItemIds) : null;
  if (!Number.isSafeInteger(now) || now < 0
    || attestation.version !== 1 || attestation.bindingDigest !== boardImportDigest(binding)
    || attestation.authorizationDigest !== authorizationDigest
    || attestation.companyId !== binding.companyId || attestation.projectId !== binding.projectId
    || attestation.boardId !== binding.boardId || attestation.boardUrl !== binding.boardUrl
    || typeof attestation.sourceUpdatedAt !== "string" || !Number.isFinite(Date.parse(attestation.sourceUpdatedAt))
    || attestation.complete !== true || attestation.nextCursor !== null || !Number.isSafeInteger(attestation.startedAt)
    || !Number.isSafeInteger(attestation.completedAt) || now < attestation.completedAt!
    || attestation.completedAt! < attestation.startedAt
    || attestation.completedAt! - attestation.startedAt > GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS
    || now - attestation.completedAt! > GITHUB_PROJECT_ATTESTATION_MAX_AGE_MS
    || !Array.isArray(attestation.issues) || !Array.isArray(attestation.seenItemIds)
    || !Number.isSafeInteger(attestation.pages) || attestation.pages < 1 || attestation.pages > 20
    || !Number.isSafeInteger(attestation.totalCount) || attestation.totalCount! < 0
    || attestation.seenItemIds.length !== attestation.totalCount || attestation.seenItemIds.length > 1000
    || attestation.issues.length > attestation.seenItemIds.length
    || seenItemIds === null || seenItemIds.size !== attestation.seenItemIds.length
    || attestation.seenItemIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_=-]{1,256}$/.test(id))
    || attestation.issues.some(issue => !issue || typeof issue !== "object"
      || !seenItemIds.has(issue.boardItemId))
    || new Set(attestation.issues.map(issue => issue.boardItemId)).size !== attestation.issues.length
    || new Set(attestation.issues.map(issue => issue.githubIssueNodeId)).size !== attestation.issues.length
    || new Set(attestation.issues.map(issue => issue.sourceUrl)).size !== attestation.issues.length) {
    throw conflict("A fresh complete host-observed board preview is required before import");
  }
  return attestation;
}
/**
 * Validate the complete attestation once, then check any number of intents
 * against it with an indexed lookup. A plan over a whole board uses this, so
 * the attestation is not revalidated per intent. An independent import
 * boundary uses `assertGitHubProjectAttestedIntent`, which validates in full.
 */
export function gitHubProjectAttestedIntentChecker(
  value: unknown, binding: GitHubProjectBinding, authorizationDigest: string, now = Date.now(),
): { attestation: GitHubProjectAttestation; assertIntent: (intent: BoardImportIntent) => void } {
  const attestation = assertCompleteGitHubProjectAttestation(value, binding, authorizationDigest, now);
  // Board item ids are unique in a complete attestation (checked above).
  const issuesByBoardItemId = new Map(attestation.issues.map(issue => [issue.boardItemId, issue] as const));
  const assertIntent = (intent: BoardImportIntent) => {
    if (intent.companyId !== binding.companyId || intent.projectId !== binding.projectId
      || intent.boardId !== binding.boardId || intent.boardUrl !== binding.boardUrl
      || attestation.sourceUpdatedAt !== intent.sourceUpdatedAt) {
      throw conflict("A fresh complete host-observed board preview is required before import");
    }
    const observed = issuesByBoardItemId.get(intent.boardItemId);
    if (!observed || observed.githubIssueNodeId !== intent.githubIssueNodeId || observed.title !== intent.task.title
      || observed.sourceUrl !== intent.task.sourceUrl || !isDeepStrictEqual(observed.fields, intent.fields)) {
      throw conflict("Import intent differs from the host-observed GitHub issue and board metadata");
    }
  };
  return { attestation, assertIntent };
}
export function assertGitHubProjectAttestedIntent(
  value: unknown, binding: GitHubProjectBinding, intent: BoardImportIntent, authorizationDigest: string, now = Date.now(),
) {
  gitHubProjectAttestedIntentChecker(value, binding, authorizationDigest, now).assertIntent(intent);
}
