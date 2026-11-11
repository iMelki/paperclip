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

/**
 * Connection facts that GitHub OAuth rewrites on every token refresh (the access token lasts 8 hours). They carry no
 * consent: who is connected, with which scopes, to which app and server are other fields and stay in the digest.
 * Every other field is kept, so an unknown new field fails closed (consent is revoked) rather than open.
 */
const ROTATING_CONNECTION_PATHS: readonly (readonly string[])[] = [
  ["oauth", "expiresAt"], ["oauth", "refreshedAt"],
  ["providerMetadata", "oauth", "expiresAt"], ["providerMetadata", "githubOAuth", "verifiedAt"],
];

/** Scope lists carry the same consent in any order or separator ("a b", "a,b", ["b","a"]). */
const SCOPE_PATHS: readonly (readonly string[])[] = [["oauth", "scope"], ["oauth", "scopes"], ["providerMetadata", "oauth", "scope"]];
function normalizeScopeValue(value: unknown): unknown {
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean).sort().join(" ");
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return [...new Set(value as string[])].sort();
  return value;
}

/** Object key order carries no consent either: hash every object with its keys sorted. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function withoutRotatingPaths(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const path of SCOPE_PATHS) {
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
    const last = path[path.length - 1];
    if (node && typeof node === "object" && last in (node as Record<string, unknown>)) {
      (node as Record<string, unknown>)[last] = normalizeScopeValue((node as Record<string, unknown>)[last]);
    }
  }
  for (const path of ROTATING_CONNECTION_PATHS) {
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
    if (node && typeof node === "object") delete (node as Record<string, unknown>)[path[path.length - 1]];
  }
  return canonicalJson(copy);
}

function withoutSecretIds(refs: unknown): unknown {
  if (!Array.isArray(refs)) return refs;
  // A refresh that returns no new refresh token rewrites the refs in another order, so the order carries no consent.
  return refs.map(ref => {
    if (!ref || typeof ref !== "object") return ref;
    const { secretId: _secretId, ...stable } = ref as Record<string, unknown>;
    return stable;
  }).sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0);
}

/**
 * Standing consent for a scheduled board import. It must survive the routine token rotation that GitHub OAuth does
 * every 8 hours, or the grant stops working at the first rotation after it is granted (the live grant did, 2026-10-27).
 * It excludes row freshness, the token expiry/refresh/verify times and the id and version of the current token secret.
 * It keeps the connection, application, transport, status, ownership, client, scopes, URLs and the bound account.
 * Provider reads still re-verify the bound account id and login, and the token secret must be active, on every read.
 */
export function githubProjectConsentDigest(
  connection: Parameters<typeof githubProjectAuthorizationDigest>[0],
  credential: Parameters<typeof githubProjectAuthorizationDigest>[1],
) {
  // Validate the real credential revision shape, then hash a fixed sentinel instead of its rotating value.
  githubProjectAuthorizationDigest(connection, credential);
  return boardImportDigest({ kind: "github-project-standing-consent-v2",
    authorization: githubProjectAuthorizationDigest({ ...connection,
      updatedAt: new Date(0), updatedAtExact: "1970-01-01T00:00:00.000000Z",
      config: withoutRotatingPaths(connection.config), transportConfig: withoutRotatingPaths(connection.transportConfig),
      credentialSecretRefs: withoutSecretIds(connection.credentialSecretRefs),
      credentialRefs: withoutSecretIds(connection.credentialRefs),
    }, { secretId: "00000000-0000-0000-0000-000000000000", latestVersion: 1 }) });
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
