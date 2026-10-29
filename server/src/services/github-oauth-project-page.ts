import { z } from "zod";
import { unprocessable } from "../errors.js";
import { GitHubOAuthTransportError, type GitHubGuardedFetch } from "./github-oauth-transport.js";
import { boardImportDigest } from "./plugin-imported-issues-contract.js";
import { exactTimestampRevision } from "./exact-timestamp-revision.js";

/** Exact persisted authorization revision, not token material. Nested JSON is encoded as returned by the native DB. */
export function githubProjectAuthorizationDigest(connection: {
  applicationId: string; updatedAt: Date; updatedAtExact?: string; transport: string; authKind: string; status: string; enabled: boolean;
  ownership: string; config: unknown; transportConfig: unknown; credentialSecretRefs: unknown; credentialRefs: unknown;
}, credential: { secretId: string; latestVersion: number }) {
  if (!credential || !/^[a-f\d-]{36}$/i.test(credential.secretId)
    || !Number.isSafeInteger(credential.latestVersion) || credential.latestVersion < 1) {
    throw unprocessable("Missing native GitHub credential revision metadata");
  }
  return boardImportDigest({ applicationId: connection.applicationId, updatedAt: exactTimestampRevision(connection),
    transport: connection.transport, authKind: connection.authKind, status: connection.status, enabled: connection.enabled,
    ownership: connection.ownership, config: connection.config, transportConfig: connection.transportConfig,
    credentialSecretRefs: connection.credentialSecretRefs, credentialRefs: connection.credentialRefs,
    credentialRevision: credential });
}

const owner = z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i);
const pageSchema = z.object({
  ownerType: z.enum(["user", "organization"]), owner,
  number: z.number().int().min(1).max(2147483647),
  after: z.string().min(1).max(512).regex(/^[A-Za-z0-9_+/=-]+$/).nullable(),
  first: z.number().int().min(1).max(50),
}).strict();
export type GitHubProjectPageInput = z.infer<typeof pageSchema>;
export function validateGitHubProjectPageInput(value: unknown): GitHubProjectPageInput {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success) throw unprocessable("Invalid bounded GitHub Project page request");
  return parsed.data;
}
export function parseGitHubProjectBoardUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw unprocessable("Invalid canonical GitHub board URL");
  let url: URL;
  try { url = new URL(value); } catch { throw unprocessable("Invalid canonical GitHub board URL"); }
  const match = url.pathname.match(/^\/(users|orgs)\/([^/]+)\/projects\/([1-9]\d*)$/);
  if (!match || url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username
    || url.password || url.search || url.hash || url.href !== value) throw unprocessable("Invalid canonical GitHub board URL");
  const page = validateGitHubProjectPageInput({ ownerType: match[1] === "users" ? "user" : "organization",
    owner: match[2], number: Number(match[3]), after: null, first: 1 });
  return { ownerType: page.ownerType, owner: page.owner, number: page.number, url: value };
}

/** Fixed read-only query, aligned with the plugin's MIT-adapted Projects reader. No caller query is accepted. */
export function githubProjectPageQuery(ownerType: GitHubProjectPageInput["ownerType"]): string {
  if (!["user", "organization"].includes(ownerType)) throw unprocessable("Invalid GitHub Project owner type");
  return `query($owner:String!,$number:Int!,$after:String,$first:Int!){
    ${ownerType}(login:$owner){projectV2(number:$number){id title url updatedAt
      items(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{
        id isArchived content{__typename
          ... on Issue{id number title url state repository{nameWithOwner}}
          ... on PullRequest{title url repository{nameWithOwner}}
          ... on DraftIssue{title}}
        fieldValues(first:100){pageInfo{hasNextPage} nodes{
          ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}
        }}
      }}
    }}
  }`;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function checkedGitHubProjectPage(value: unknown, input: GitHubProjectPageInput) {
  const root = record(value) ? value[input.ownerType] : null;
  const board = record(root) ? root.projectV2 : null;
  const items = record(board) ? board.items : null;
  const info = record(items) ? items.pageInfo : null;
  const url = `https://github.com/${input.ownerType === "user" ? "users" : "orgs"}/${input.owner}/projects/${input.number}`;
  if (!record(value) || "errors" in value || !record(board) || board.url !== url
    || typeof board.id !== "string" || !/^[A-Za-z0-9_=-]{1,256}$/.test(board.id)
    || typeof board.title !== "string" || !board.title.trim() || board.title.length > 4096
    || typeof board.updatedAt !== "string" || !Number.isFinite(Date.parse(board.updatedAt))
    || !record(items) || !Number.isSafeInteger(items.totalCount) || (items.totalCount as number) < 0
    || !Array.isArray(items.nodes) || items.nodes.length > input.first || !record(info)
    || typeof info.hasNextPage !== "boolean"
    || (info.hasNextPage && (typeof info.endCursor !== "string" || !info.endCursor
      || info.endCursor === input.after || info.endCursor.length > 512))
    || (!info.hasNextPage && info.endCursor !== null && typeof info.endCursor !== "string")
    || items.nodes.some(item => !record(item) || typeof item.id !== "string"
      || typeof item.isArchived !== "boolean" || !record(item.fieldValues)
      || !record(item.fieldValues.pageInfo) || item.fieldValues.pageInfo.hasNextPage !== false
      || !Array.isArray(item.fieldValues.nodes) || item.fieldValues.nodes.length > 100)) {
    throw new GitHubOAuthTransportError("github_project_page_incomplete");
  }
  return { data: value, board: { id: board.id, title: board.title, url, updatedAt: board.updatedAt } };
}

async function boundedJson(response: Response) {
  const size = response.headers.get("content-length");
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 1_000_000)
    || !mediaType || !(mediaType === "application/json" || mediaType.endsWith("+json")) || !response.body) {
    throw new GitHubOAuthTransportError("github_project_response_invalid");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.length;
      if (count > 1_000_000) throw new GitHubOAuthTransportError("github_project_response_too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new GitHubOAuthTransportError("github_project_response_invalid"); }
}

export async function readGitHubOAuthProjectPage(
  value: unknown, headers: Record<string, string>, guardedFetch: GitHubGuardedFetch,
) {
  const input = validateGitHubProjectPageInput(value);
  if (Object.keys(headers).length !== 1 || !/^Bearer [\x21-\x7e]{1,4096}$/.test(headers.Authorization ?? "")) {
    throw new GitHubOAuthTransportError("github_oauth_bearer_invalid", 422);
  }
  try {
    const response = await guardedFetch("https://api.github.com/graphql", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { ...headers, Accept: "application/vnd.github+json", "Content-Type": "application/json",
        "User-Agent": "Paperclip-Workspace-Connector", "X-GitHub-Api-Version": "2026-03-10" },
      body: JSON.stringify({ query: githubProjectPageQuery(input.ownerType), variables: {
        owner: input.owner, number: input.number, after: input.after, first: input.first,
      } }),
    });
    if (!response.ok || response.redirected) throw new GitHubOAuthTransportError("github_project_read_failed");
    const payload = await boundedJson(response);
    if (!record(payload) || "errors" in payload || !record(payload.data)) {
      throw new GitHubOAuthTransportError("github_project_read_incomplete");
    }
    return checkedGitHubProjectPage(payload.data, input);
  } catch (error) {
    if (error instanceof GitHubOAuthTransportError) throw error;
    throw new GitHubOAuthTransportError("github_project_read_failed");
  }
}
