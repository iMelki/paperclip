import { createHash } from "node:crypto";
import {
  GITHUB_OAUTH_API_URL,
  GITHUB_OAUTH_AUTHORIZATION_URL,
  GITHUB_OAUTH_METHOD_KEY,
  GITHUB_OAUTH_TOKEN_URL,
  GITHUB_OAUTH_USER_URL,
  GitHubOAuthValidationError,
  verifyGitHubOAuthExpiry,
  verifyGitHubOAuthGrant,
} from "@paperclipai/shared/github-oauth";
import type { GitHubOAuthGrantFacts } from "@paperclipai/shared/github-oauth";
import { HttpError } from "../errors.js";

export type GitHubGuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type GitHubOAuthAuthorizationFacts = GitHubOAuthGrantFacts & {
  rawTokenGrantedScopes: string;
  tokenGrantedScopes: string[];
};
export type GitHubOAuthToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  risk: "read" | "write";
};
type JsonSchema = {
  type: "object" | "string" | "integer" | "number";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  minProperties?: number;
  maxProperties?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
};
type ToolSpec = { name: string; description: string; risk: "read" | "write"; schema: JsonSchema };
type GitHubRequest = { url: string; method: "GET" | "POST" | "PATCH" | "PUT"; body?: string };
const RESPONSE_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const API_VERSION = "2026-03-10";

/** Shown on a 422 when GitHub returns private-repository access for a public-only connection. */
export const GITHUB_OAUTH_SCOPES_TOO_BROAD_MESSAGE = "GitHub granted private-repository access (repo or project scope) from an earlier sign-in, "
  + "but this connection is public repositories only. Tick 'Include private repositories' and connect again, "
  + "or revoke this OAuth App in GitHub settings (Settings > Applications > Authorized OAuth Apps) and reconnect. Nothing was saved.";

export class GitHubOAuthTransportError extends HttpError {
  readonly code: string;
  constructor(code: string, status = 502, dispatched = false, outcomeUnknown = false, message?: string) {
    super(status, message ?? code, { code, dispatched, outcomeUnknown });
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validConfig(config: unknown): boolean {
  if (!record(config) || config.sourceTemplateKey !== "github"
    || config.methodKey !== GITHUB_OAUTH_METHOD_KEY || !record(config.oauth)) return false;
  return config.oauth.provider === "github"
    && config.oauth.authorizationUrl === GITHUB_OAUTH_AUTHORIZATION_URL
    && config.oauth.tokenUrl === GITHUB_OAUTH_TOKEN_URL
    && config.serverUrl === GITHUB_OAUTH_API_URL;
}

export function isNativeGitHubOAuthConnection(connection: {
  transport: string; authKind?: string | null; config: unknown; transportConfig?: unknown;
}): boolean {
  return connection.transport === "rest_api"
    && (connection.authKind === undefined || connection.authKind === "oauth")
    && validConfig(connection.config)
    && (connection.transportConfig === undefined || validConfig(connection.transportConfig));
}
export const isGitHubOAuthConnection = isNativeGitHubOAuthConnection;

function tokenHeaders(headers: Record<string, string>): Record<string, string> {
  const bearer = Object.entries(headers).filter(([key]) => key.toLowerCase() === "authorization");
  if (bearer.length !== 1 || !/^Bearer [\x21-\x7e]{1,4096}$/.test(bearer[0][1])) {
    throw new GitHubOAuthTransportError("github_oauth_bearer_invalid", 422);
  }
  return {
    Authorization: bearer[0][1],
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "Paperclip-Workspace-Connector",
    "Content-Type": "application/json",
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_MAX_BYTES)) {
    throw new GitHubOAuthTransportError("github_response_too_large");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !(contentType === "application/json" || contentType.endsWith("+json")) || !response.body) {
    throw new GitHubOAuthTransportError("github_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw new GitHubOAuthTransportError("github_response_too_large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new GitHubOAuthTransportError("github_response_invalid"); }
}

/** The injected host fetch MUST honor redirect:manual before forwarding a bearer. No retry. */
async function requestGitHub(
  request: GitHubRequest, headers: Record<string, string>, guardedFetch: GitHubGuardedFetch,
  write = false, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ payload: unknown; response: Response }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new GitHubOAuthTransportError("github_timeout_invalid", 422);
  }
  const safeHeaders = tokenHeaders(headers);
  const controller = new AbortController();
  let dispatched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    dispatched = true;
    const response = await guardedFetch(request.url, {
      method: request.method, headers: safeHeaders, body: request.body,
      redirect: "manual", signal: controller.signal,
    });
    if (response.redirected || (response.url && response.url !== request.url)
      || (response.status >= 300 && response.status < 400)) {
      throw new GitHubOAuthTransportError("github_redirect_rejected");
    }
    if (!response.ok) throw new GitHubOAuthTransportError("github_request_failed", response.status);
    return { payload: await boundedJson(response), response };
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GitHubOAuthTransportError("github_request_timeout", 504));
      }, timeoutMs);
      timer.unref?.();
    })]);
  } catch (error) {
    const code = error instanceof GitHubOAuthTransportError ? error.code : "github_request_failed";
    const status = error instanceof GitHubOAuthTransportError ? error.status : 502;
    throw new GitHubOAuthTransportError(write && dispatched ? "github_write_outcome_unknown" : code,
      status, dispatched, write && dispatched);
  } finally { if (timer) clearTimeout(timer); }
}

export async function verifyGitHubOAuthAccount(input: {
  headers: Record<string, string>; scope: unknown; expectedLogin: string; expectedAccountId?: number;
  privateRepoAccess?: boolean;
}, guardedFetch: GitHubGuardedFetch): Promise<GitHubOAuthAuthorizationFacts> {
  const result = await requestGitHub({ url: GITHUB_OAUTH_USER_URL, method: "GET" }, input.headers, guardedFetch);
  try {
    const original = verifyGitHubOAuthGrant({
      account: result.payload, grantedScopes: input.scope,
      expectedLogin: input.expectedLogin, expectedAccountId: input.expectedAccountId,
      privateRepoAccess: input.privateRepoAccess === true,
    });
    const current = verifyGitHubOAuthGrant({
      account: result.payload, grantedScopes: result.response.headers.get("X-OAuth-Scopes"),
      expectedLogin: input.expectedLogin, expectedAccountId: input.expectedAccountId,
      privateRepoAccess: input.privateRepoAccess === true,
    });
    return { ...current, rawTokenGrantedScopes: original.rawGrantedScopes, tokenGrantedScopes: original.grantedScopes };
  } catch (error) {
    if (error instanceof GitHubOAuthValidationError) {
      throw new GitHubOAuthTransportError(error.code, 422, false, false,
        error.code === "github_oauth_scopes_too_broad" ? GITHUB_OAUTH_SCOPES_TOO_BROAD_MESSAGE : undefined);
    }
    throw error;
  }
}

export async function verifyGitHubOAuthAuthorization(input: {
  accessToken: string; scope: unknown; expiresIn: unknown; refreshToken: unknown;
  expectedLogin: string; expectedAccountId?: number; privateRepoAccess?: boolean;
}, guardedFetch: GitHubGuardedFetch): Promise<GitHubOAuthAuthorizationFacts> {
  try { verifyGitHubOAuthExpiry(input); }
  catch (error) {
    if (error instanceof GitHubOAuthValidationError) throw new GitHubOAuthTransportError(error.code, 422);
    throw error;
  }
  return verifyGitHubOAuthAccount({
    headers: { Authorization: `Bearer ${input.accessToken}` }, scope: input.scope,
    expectedLogin: input.expectedLogin, expectedAccountId: input.expectedAccountId,
    privateRepoAccess: input.privateRepoAccess === true,
  }, guardedFetch);
}

const text = (maxLength: number, pattern?: string): JsonSchema => ({ type: "string", minLength: 1, maxLength, ...(pattern ? { pattern } : {}) });
const id = text(200, "^[A-Za-z0-9_+=/-]+$");
const owner = text(39, "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$");
const repo = text(100, "^[A-Za-z0-9_.-]+$");
const page: JsonSchema = { type: "integer", minimum: 1, maximum: 1000 };
const first: JsonSchema = { type: "integer", minimum: 1, maximum: 50 };
const cursor = text(512, "^[\\x21-\\x7e]+$");
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object", properties, required, additionalProperties: false,
});
const repositoryArgs = { owner, repo };
const issueEdits = { title: text(256), body: { type: "string", maxLength: 32768 } as JsonSchema,
  state: { type: "string", enum: ["open", "closed"] } as JsonSchema };
const value: JsonSchema = { ...object({ text: { type: "string", maxLength: 4096 },
  number: { type: "number" }, date: text(10, "^\\d{4}-\\d{2}-\\d{2}$"),
  singleSelectOptionId: id, iterationId: id }), minProperties: 1, maxProperties: 1 };
const SPECS: ToolSpec[] = [
  { name: "github_get_account", risk: "read", description: "Read the authenticated GitHub account.", schema: object({}) },
  { name: "github_list_repositories", risk: "read", description: "Read one bounded page of accessible repositories.", schema: object({ page, first }) },
  { name: "github_list_repository_issues", risk: "read", description: "Read one repository issue page; GitHub may include pull requests.",
    schema: object({ ...repositoryArgs, page, first, state: { type: "string", enum: ["open", "closed", "all"] } }, ["owner", "repo"]) },
  { name: "github_get_repository_file", risk: "read", description: "Read one repository file and its current SHA through the Contents API.",
    schema: object({ ...repositoryArgs, path: text(1024), ref: text(200) }, ["owner", "repo", "path"]) },
  { name: "github_list_projects", risk: "read", description: "Read one personal or organization Projects page.",
    schema: object({ owner, ownerType: { type: "string", enum: ["user", "organization"] }, first, after: cursor }, ["owner", "ownerType"]) },
  { name: "github_get_project_items", risk: "read", description: "Read bounded Project items and fields; retain pagination and redacted items.",
    schema: object({ projectId: id, first, after: cursor }, ["projectId"]) },
  { name: "github_create_or_update_file", risk: "write", description: "Write one file on an explicitly chosen branch; updates require its existing SHA. Workflow files are excluded.",
    schema: object({ ...repositoryArgs, path: text(1024), branch: text(200), message: text(5000), content: text(131072, "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"),
      sha: text(40, "^[a-fA-F0-9]{40}$") }, ["owner", "repo", "path", "branch", "message", "content"]) },
  { name: "github_create_issue", risk: "write", description: "Create one GitHub issue without assigning agents or changing Project fields.",
    schema: object({ ...repositoryArgs, title: issueEdits.title, body: issueEdits.body }, ["owner", "repo", "title"]) },
  { name: "github_update_issue", risk: "write", description: "Update one GitHub issue title, body, or state; assignments and labels are excluded.",
    schema: object({ ...repositoryArgs, issueNumber: { type: "integer", minimum: 1, maximum: 1_000_000 }, ...issueEdits }, ["owner", "repo", "issueNumber"]) },
  { name: "github_update_project", risk: "write", description: "Update a Project title or short description without changing its visibility.",
    schema: object({ projectId: id, title: text(256), shortDescription: { type: "string", maxLength: 1024 } }, ["projectId"]) },
  { name: "github_add_project_item", risk: "write", description: "Add an existing issue or pull request to one Project; no new task or agent run is created.",
    schema: object({ projectId: id, contentId: id }, ["projectId", "contentId"]) },
  { name: "github_update_project_item_field", risk: "write", description: "Update one text, number, date, single-select, or iteration Project field. This is a GitHub write, not Paperclip dispatch.",
    schema: object({ projectId: id, itemId: id, fieldId: id, value }, ["projectId", "itemId", "fieldId", "value"]) },
];

function descriptor(spec: ToolSpec): GitHubOAuthToolDescriptor {
  return structuredClone({ name: spec.name, description: spec.description, inputSchema: spec.schema,
    annotations: { readOnlyHint: spec.risk === "read", destructiveHint: false, openWorldHint: true }, risk: spec.risk });
}
export function githubOAuthToolDescriptors(): GitHubOAuthToolDescriptor[] { return SPECS.map(descriptor); }
export function getGitHubOAuthToolDescriptor(name: string): GitHubOAuthToolDescriptor | null {
  const spec = SPECS.find((candidate) => candidate.name === name);
  return spec ? descriptor(spec) : null;
}

function validate(value: unknown, schema: JsonSchema): boolean {
  if (schema.type === "object") {
    if (!record(value)) return false;
    const keys = Object.keys(value);
    const properties = schema.properties ?? {};
    return (schema.minProperties === undefined || keys.length >= schema.minProperties)
      && (schema.maxProperties === undefined || keys.length <= schema.maxProperties)
      && (schema.required ?? []).every((key) => Object.hasOwn(value, key))
      && keys.every((key) => Object.hasOwn(properties, key) && validate(value[key], properties[key]));
  }
  if (schema.type === "string") return typeof value === "string"
    && (schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength)
    && (schema.enum === undefined || schema.enum.includes(value))
    && (schema.pattern === undefined || new RegExp(schema.pattern).test(value));
  return typeof value === "number" && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isSafeInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
}

function graphql(query: string, variables: Record<string, unknown>): GitHubRequest {
  return { url: `${GITHUB_OAUTH_API_URL}/graphql`, method: "POST", body: JSON.stringify({ query, variables }) };
}
function repositoryPath(args: Record<string, unknown>): string {
  if (args.repo === "." || args.repo === "..") throw new GitHubOAuthTransportError("github_arguments_invalid", 422);
  return `${GITHUB_OAUTH_API_URL}/repos/${encodeURIComponent(args.owner as string)}/${encodeURIComponent(args.repo as string)}`;
}
function filePath(path: string, write = false): string {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[%\\\x00-\x1f\x7f]/.test(part))
    || (write && parts[0].toLowerCase() === ".github" && parts[1]?.toLowerCase() === "workflows")) {
    throw new GitHubOAuthTransportError("github_file_path_invalid", 422);
  }
  return parts.map(encodeURIComponent).join("/");
}
const PROJECT_FIELDS = "id number title url closed shortDescription";
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const ITEMS_QUERY = `query($projectId: ID!, $first: Int!, $after: String) { node(id: $projectId) {
  ... on ProjectV2 { ${PROJECT_FIELDS} fields(first: 20) { ${PAGE_INFO} nodes {
    ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } }
    ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } } }
  } } items(first: $first, after: $after) { ${PAGE_INFO} nodes { id type isArchived
    fieldValues(first: 20) { ${PAGE_INFO} nodes { ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
      ... on ProjectV2ItemFieldTextValue { text } ... on ProjectV2ItemFieldNumberValue { number }
      ... on ProjectV2ItemFieldDateValue { date } } }
    content { __typename ... on Issue { id number title url state repository { nameWithOwner } }
      ... on PullRequest { id number title url state repository { nameWithOwner } }
      ... on DraftIssue { id title body } } } } } } }`;
const FIELD_VALUE_READBACK = `fieldValues(first: 50) { ${PAGE_INFO} nodes {
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2FieldCommon { id } } }
} }`;

function buildRequest(name: string, args: Record<string, unknown>): GitHubRequest {
  const first = args.first ?? 20;
  const page = args.page ?? 1;
  if (name === "github_get_account") return { url: GITHUB_OAUTH_USER_URL, method: "GET" };
  if (name === "github_list_repositories") return { url: `${GITHUB_OAUTH_API_URL}/user/repos?per_page=${first}&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`, method: "GET" };
  if (name === "github_list_repository_issues") return { url: `${repositoryPath(args)}/issues?state=${args.state ?? "all"}&per_page=${first}&page=${page}`, method: "GET" };
  if (name === "github_get_repository_file") return { url: `${repositoryPath(args)}/contents/${filePath(args.path as string)}${args.ref === undefined ? "" : `?ref=${encodeURIComponent(args.ref as string)}`}`, method: "GET" };
  if (name === "github_list_projects") return graphql(
    `query($owner: String!, $first: Int!, $after: String) { ${args.ownerType}(login: $owner) { projectsV2(first: $first, after: $after) { ${PAGE_INFO} nodes { ${PROJECT_FIELDS} } } } }`,
    { owner: args.owner, first, after: args.after ?? null });
  if (name === "github_get_project_items") return graphql(ITEMS_QUERY, { projectId: args.projectId, first, after: args.after ?? null });
  if (name === "github_create_or_update_file") {
    const { owner: _owner, repo: _repo, path, ...body } = args;
    return { url: `${repositoryPath(args)}/contents/${filePath(path as string, true)}`, method: "PUT", body: JSON.stringify(body) };
  }
  if (name === "github_create_issue" || name === "github_update_issue") {
    const { owner: _owner, repo: _repo, issueNumber, ...body } = args;
    if (!Object.keys(body).length) throw new GitHubOAuthTransportError("github_arguments_invalid", 422);
    return { url: `${repositoryPath(args)}/issues${issueNumber === undefined ? "" : `/${issueNumber}`}`,
      method: name === "github_create_issue" ? "POST" : "PATCH", body: JSON.stringify(body) };
  }
  if (name === "github_update_project") {
    if (args.title === undefined && args.shortDescription === undefined) throw new GitHubOAuthTransportError("github_arguments_invalid", 422);
    return graphql("mutation($input: UpdateProjectV2Input!) { updateProjectV2(input: $input) { projectV2 { id title shortDescription } } }", { input: args });
  }
  if (name === "github_add_project_item") return graphql(`mutation($input: AddProjectV2ItemByIdInput!) {
    addProjectV2ItemById(input: $input) { item { id type isArchived project { id }
      content { __typename ... on Issue { id } ... on PullRequest { id } } } } }`, { input: args });
  const value = args.value as Record<string, unknown>;
  if (value.date !== undefined && (!Number.isFinite(Date.parse(value.date as string))
    || new Date(value.date as string).toISOString().slice(0, 10) !== value.date)) {
    throw new GitHubOAuthTransportError("github_arguments_invalid", 422);
  }
  return graphql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id project { id } ${FIELD_VALUE_READBACK} } } }`, { input: args });
}

function positiveId(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function connectionPayload(value: unknown): boolean {
  return record(value) && Array.isArray(value.nodes) && record(value.pageInfo)
    && typeof value.pageInfo.hasNextPage === "boolean"
    && (value.pageInfo.endCursor === null || typeof value.pageInfo.endCursor === "string");
}
function requestedEditsMatch(payload: Record<string, unknown>, args: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => args[key] === undefined || payload[key] === args[key]);
}
function fieldValueMatches(item: Record<string, unknown>, args: Record<string, unknown>): boolean {
  if (item.id !== args.itemId || !record(item.project) || item.project.id !== args.projectId
    || !connectionPayload(item.fieldValues)) return false;
  const fields = item.fieldValues as { nodes: unknown[] };
  const matches = fields.nodes.filter((field) => record(field) && record(field.field) && field.field.id === args.fieldId);
  if (matches.length !== 1 || !record(matches[0])) return false;
  const requested = args.value as Record<string, unknown>;
  const key = Object.keys(requested)[0];
  return matches[0][key === "singleSelectOptionId" ? "optionId" : key] === requested[key];
}
function projectMembershipMatches(item: unknown, args: Record<string, unknown>): boolean {
  return record(item) && typeof item.id === "string" && item.id.length > 0 && item.isArchived === false
    && record(item.project) && item.project.id === args.projectId && record(item.content)
    && item.content.id === args.contentId
    && ((item.type === "ISSUE" && item.content.__typename === "Issue")
      || (item.type === "PULL_REQUEST" && item.content.__typename === "PullRequest"));
}
function validGraphqlResult(name: string, args: Record<string, unknown>, payload: unknown): boolean {
  if (!record(payload) || !record(payload.data)
    || (Object.hasOwn(payload, "errors") && (!Array.isArray(payload.errors) || payload.errors.length > 0))) return false;
  const data = payload.data;
  if (name === "github_list_projects") {
    const account = data[args.ownerType as string];
    return record(account) && connectionPayload(account.projectsV2);
  }
  if (name === "github_get_project_items") return record(data.node) && data.node.id === args.projectId
    && connectionPayload(data.node.items) && connectionPayload(data.node.fields);
  if (name === "github_update_project") return record(data.updateProjectV2)
    && record(data.updateProjectV2.projectV2) && data.updateProjectV2.projectV2.id === args.projectId
    && requestedEditsMatch(data.updateProjectV2.projectV2, args, ["title", "shortDescription"]);
  if (name === "github_add_project_item") return record(data.addProjectV2ItemById)
    && projectMembershipMatches(data.addProjectV2ItemById.item, args);
  return record(data.updateProjectV2ItemFieldValue) && record(data.updateProjectV2ItemFieldValue.projectV2Item)
    && fieldValueMatches(data.updateProjectV2ItemFieldValue.projectV2Item, args);
}
function repositoryResponseUrlMatches(raw: unknown, args: Record<string, unknown>, suffix: string,
  origin = GITHUB_OAUTH_API_URL): boolean {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return false;
    const parts = decodeURIComponent(url.pathname).split("/");
    if (origin === GITHUB_OAUTH_API_URL && parts.splice(1, 1)[0] !== "repos") return false;
    return parts[1]?.toLowerCase() === (args.owner as string).toLowerCase()
      && parts[2]?.toLowerCase() === (args.repo as string).toLowerCase()
      && `/${parts.slice(3).join("/")}` === suffix;
  } catch { return false; }
}
function fileWriteMatches(payload: Record<string, unknown>, args: Record<string, unknown>): boolean {
  if (!record(payload.content) || !record(payload.commit) || payload.content.type !== "file"
    || payload.content.path !== args.path || typeof payload.content.sha !== "string"
    || typeof payload.commit.sha !== "string" || !/^[a-fA-F0-9]{40}$/.test(payload.commit.sha)) return false;
  const bytes = Buffer.from(args.content as string, "base64");
  const expectedSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return payload.content.sha === expectedSha && payload.content.size === bytes.length
    && repositoryResponseUrlMatches(payload.content.git_url, args, `/git/blobs/${expectedSha}`)
    && repositoryResponseUrlMatches(payload.commit.url, args, `/git/commits/${payload.commit.sha}`)
    && repositoryResponseUrlMatches(payload.content.html_url, args,
      `/blob/${args.branch}/${args.path}`, "https://github.com");
}
function validRestResult(name: string, args: Record<string, unknown>, payload: unknown): boolean {
  if (name === "github_list_repositories") return Array.isArray(payload)
    && payload.every((item) => record(item) && positiveId(item.id) && typeof item.full_name === "string");
  if (name === "github_list_repository_issues") return Array.isArray(payload)
    && payload.every((item) => record(item) && positiveId(item.id) && positiveId(item.number) && typeof item.title === "string");
  if (!record(payload)) return false;
  if (name === "github_get_account") return positiveId(payload.id) && typeof payload.login === "string" && payload.type === "User";
  if (name === "github_get_repository_file") return payload.type === "file" && payload.path === args.path
    && typeof payload.sha === "string" && /^[a-fA-F0-9]{40}$/.test(payload.sha)
    && payload.encoding === "base64" && typeof payload.content === "string";
  if (name === "github_create_or_update_file") return fileWriteMatches(payload, args);
  return positiveId(payload.id) && positiveId(payload.number) && typeof payload.title === "string"
    && (name !== "github_update_issue" || payload.number === args.issueNumber)
    && requestedEditsMatch(payload, args, ["title", "body", "state"]);
}

/** Fixed catalog only. Caller owns company authorization, policy approval, and durable write intent. */
export async function executeGitHubOAuthTool(input: {
  toolName: string; arguments: unknown; headers: Record<string, string>; timeoutMs?: number;
}, guardedFetch: GitHubGuardedFetch): Promise<unknown> {
  const spec = SPECS.find((candidate) => candidate.name === input.toolName);
  if (!spec || !validate(input.arguments, spec.schema)) throw new GitHubOAuthTransportError("github_arguments_invalid", 422);
  const args = input.arguments as Record<string, unknown>;
  const request = buildRequest(spec.name, args);
  const result = await requestGitHub(request, input.headers, guardedFetch, spec.risk === "write", input.timeoutMs);
  const graphql = request.url.endsWith("/graphql");
  if (!(graphql ? validGraphqlResult(spec.name, args, result.payload) : validRestResult(spec.name, args, result.payload))) {
    throw new GitHubOAuthTransportError(spec.risk === "write" ? "github_write_outcome_unknown" : graphql ? "github_graphql_failed" : "github_response_invalid",
      502, true, spec.risk === "write");
  }
  return result.payload;
}
