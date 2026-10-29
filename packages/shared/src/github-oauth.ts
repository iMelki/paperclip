import type { AppDefinition, ConnectionMethodDef } from "./types/app-definition.js";

export const GITHUB_OAUTH_METHOD_KEY = "rest-oauth";
export const GITHUB_OAUTH_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_OAUTH_API_URL = "https://api.github.com";
export const GITHUB_OAUTH_USER_URL = "https://api.github.com/user";
export const GITHUB_OAUTH_REQUIRED_SCOPES = ["repo", "project"] as const;
export const GITHUB_OAUTH_REQUESTED_SCOPES = ["repo", "project", "offline_access"] as const;
// GitHub currently documents eight-hour access tokens; bound malformed expiry metadata.
export const GITHUB_OAUTH_MAX_ACCESS_TTL_SECONDS = 86_400;

export interface GitHubOAuthProviderConfig {
  provider: "github";
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface GitHubOAuthGrantInput {
  /** The response from an authenticated, server-owned GET /user, not UI input. */
  account: unknown;
  /** Actual token-response scope metadata, never the requested scope list. */
  grantedScopes: unknown;
  expectedLogin: string;
  expectedAccountId?: number;
}

export interface GitHubOAuthGrantFacts {
  provider: "github";
  accountId: number;
  login: string;
  rawGrantedScopes: string;
  grantedScopes: string[];
}

export type GitHubOAuthValidationCode =
  | "github_oauth_client_id_invalid"
  | "github_oauth_scope_metadata_invalid"
  | "github_oauth_scopes_insufficient"
  | "github_oauth_account_invalid"
  | "github_oauth_account_mismatch"
  | "github_oauth_expiry_invalid"
  | "github_oauth_refresh_missing";

export class GitHubOAuthValidationError extends Error {
  constructor(public readonly code: GitHubOAuthValidationCode) {
    super(code);
    this.name = "GitHubOAuthValidationError";
  }
}

function refuse(code: GitHubOAuthValidationCode): never {
  throw new GitHubOAuthValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGitHubLogin(value: unknown): value is string {
  return typeof value === "string" && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);
}

function isAccountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Public metadata only. Company boundaries, secret references, and state are host-owned. */
export function createGitHubOAuthProviderConfig(clientId: string): GitHubOAuthProviderConfig {
  if (typeof clientId !== "string") refuse("github_oauth_client_id_invalid");
  const normalized = clientId.trim();
  if (!/^[a-z\d_-]{1,128}$/i.test(normalized)
    || /^(?:github_pat_|gh[opusr]_)/i.test(normalized)) {
    refuse("github_oauth_client_id_invalid");
  }
  return {
    provider: "github",
    clientId: normalized,
    authorizationUrl: GITHUB_OAUTH_AUTHORIZATION_URL,
    tokenUrl: GITHUB_OAUTH_TOKEN_URL,
    scopes: [...GITHUB_OAUTH_REQUESTED_SCOPES],
  };
}

/** Dedicated selection must not change the gallery's existing first-method behavior. */
export function getGitHubOAuthConnectionMethod(app: AppDefinition): ConnectionMethodDef | null {
  if (app.slug !== "github" || app.ownershipAvailability?.customer === false) return null;
  const candidates = app.methods.filter((method) => method.key === GITHUB_OAUTH_METHOD_KEY);
  if (candidates.length !== 1) return null;
  const method = candidates[0];
  const scopes = method.defaults?.scopesHint;
  if (method.auth !== "oauth" || method.transport !== "rest_api"
    || method.ownershipModes.length !== 1 || method.ownershipModes[0] !== "customer"
    || method.defaults?.serverUrl !== GITHUB_OAUTH_API_URL
    || method.defaults?.authorizationEndpoint !== GITHUB_OAUTH_AUTHORIZATION_URL
    || method.defaults?.tokenEndpoint !== GITHUB_OAUTH_TOKEN_URL
    || scopes?.length !== GITHUB_OAUTH_REQUESTED_SCOPES.length
    || !GITHUB_OAUTH_REQUESTED_SCOPES.every((scope, index) => scopes[index] === scope)) {
    return null;
  }
  return method;
}

function parseGitHubGrantedScopes(value: unknown): { raw: string; scopes: string[] } {
  if (typeof value !== "string" || value.length > 4096
    || /[^\x20-\x7e\t\r\n]/.test(value)) {
    refuse("github_oauth_scope_metadata_invalid");
  }
  const tokens = value.split(/[, \t\r\n]+/).filter(Boolean);
  if (tokens.length > 128 || tokens.some((scope) => !/^[a-z\d:_-]+$/i.test(scope))) {
    refuse("github_oauth_scope_metadata_invalid");
  }
  return { raw: value, scopes: [...new Set(tokens)] };
}

/** Declared grant facts only: this does not prove API access or authorize an agent write. */
export function verifyGitHubOAuthGrant(input: GitHubOAuthGrantInput): GitHubOAuthGrantFacts {
  if (!isGitHubLogin(input.expectedLogin)
    || (input.expectedAccountId !== undefined && !isAccountId(input.expectedAccountId))
    || !isRecord(input.account) || input.account.type !== "User"
    || !isAccountId(input.account.id) || !isGitHubLogin(input.account.login)) {
    refuse("github_oauth_account_invalid");
  }
  if (input.account.login.toLowerCase() !== input.expectedLogin.toLowerCase()
    || (input.expectedAccountId !== undefined && input.account.id !== input.expectedAccountId)) {
    refuse("github_oauth_account_mismatch");
  }
  const parsed = parseGitHubGrantedScopes(input.grantedScopes);
  if (!GITHUB_OAUTH_REQUIRED_SCOPES.every((scope) => parsed.scopes.includes(scope))) {
    refuse("github_oauth_scopes_insufficient");
  }
  return {
    provider: "github",
    accountId: input.account.id,
    login: input.account.login,
    rawGrantedScopes: parsed.raw,
    grantedScopes: parsed.scopes,
  };
}

/** Enforce the selected expiring-token lifecycle without returning any credential. */
export function verifyGitHubOAuthExpiry(input: {
  expiresIn: unknown;
  refreshToken: unknown;
}): { expiresIn: number } {
  if (typeof input.expiresIn !== "number" || !Number.isSafeInteger(input.expiresIn)
    || input.expiresIn <= 0 || input.expiresIn > GITHUB_OAUTH_MAX_ACCESS_TTL_SECONDS) {
    refuse("github_oauth_expiry_invalid");
  }
  if (typeof input.refreshToken !== "string" || input.refreshToken.length > 4096
    || !/^[\x21-\x7e]+$/.test(input.refreshToken)) {
    refuse("github_oauth_refresh_missing");
  }
  return { expiresIn: input.expiresIn };
}
