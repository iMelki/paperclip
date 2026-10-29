import { conflict } from "../errors.js";

export interface GitHubOAuthStateBinding {
  verifier: string;
  clientId: string;
  redirectUri: string;
  expectedLogin: string;
  scopes: string[];
}

const PREFIX = "github-bound-v1:";

export function isBoundGitHubOAuthState(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Stored in the existing server-only verifier column; never returned to clients. */
export function bindGitHubOAuthState(binding: GitHubOAuthStateBinding): string {
  return PREFIX + JSON.stringify(binding);
}

export function verifyGitHubOAuthState(
  stored: string,
  expected: Omit<GitHubOAuthStateBinding, "verifier">,
): string {
  let value: unknown;
  try {
    if (!stored.startsWith(PREFIX)) throw new Error("missing binding");
    value = JSON.parse(stored.slice(PREFIX.length));
  } catch {
    throw conflict("GitHub sign-in must be restarted", { code: "github_oauth_state_binding_missing" });
  }
  const binding = value && typeof value === "object" ? value as GitHubOAuthStateBinding : null;
  if (!binding || typeof binding.verifier !== "string" || !/^[\w-]{43,128}$/.test(binding.verifier)
    || binding.clientId !== expected.clientId || binding.redirectUri !== expected.redirectUri
    || binding.expectedLogin !== expected.expectedLogin
    || JSON.stringify(binding.scopes) !== JSON.stringify(expected.scopes)) {
    throw conflict("GitHub setup changed during sign-in. Start again.", { code: "github_oauth_state_binding_changed" });
  }
  return binding.verifier;
}
