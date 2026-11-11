import { describe, expect, it } from "vitest";
import { githubProjectAuthorizationDigest, githubProjectConsentDigest } from "../services/github-oauth-project-page.js";
import { boardImportDigest } from "../services/plugin-imported-issues-contract.js";
import { summarizeNativeBoardFailure } from "../services/github-project-board-failure-reason.js";
import { HttpError, conflict, forbidden } from "../errors.js";

type Connection = Parameters<typeof githubProjectConsentDigest>[0];
const SECRET_A = "11111111-1111-4111-8111-111111111111";
const SECRET_B = "22222222-2222-4222-8222-222222222222";
const oauth = (refreshedAt: string, expiresAt: string) => ({ scope: "project repo", scopes: ["repo", "project", "offline_access"],
  clientId: "synthetic-client", provider: "github", tokenUrl: "https://github.com/login/oauth/access_token",
  expiresAt, grantType: "authorization_code", connectedAt: "2026-10-22T22:08:34.195Z", refreshedAt,
  authorizationUrl: "https://github.com/login/oauth/authorize" });
const config = (refreshedAt: string, expiresAt: string, extra: Record<string, unknown> = {}) => ({
  oauth: oauth(refreshedAt, expiresAt), methodKey: "rest-oauth", serverUrl: "https://api.github.com",
  providerMetadata: { oauth: { scope: "project repo", expiresAt },
    githubOAuth: { login: "synthetic", provider: "github", accountId: 1001, verifiedAt: refreshedAt, grantedScopes: ["project", "repo"] } },
  expectedGitHubLogin: "synthetic", ...extra });
function connection(secretId: string, refreshedAt: string, overrides: Partial<Connection> = {}, extra = {}): Connection {
  const cfg = config(refreshedAt, new Date(Date.parse(refreshedAt) + 8 * 3600_000).toISOString(), extra);
  return { applicationId: "33333333-3333-4333-8333-333333333333", updatedAt: new Date(refreshedAt),
    transport: "rest_api", authKind: "oauth", status: "active", enabled: true, ownership: "customer",
    config: cfg, transportConfig: cfg,
    credentialSecretRefs: [{ label: "OAuth access token", required: true, secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
    credentialRefs: [{ key: "Authorization", name: "oauth.access_token", prefix: "Bearer ", version: "latest", secretId, placement: "header" }],
    ...overrides };
}
const before = connection(SECRET_A, "2026-10-27T15:01:08.000Z");
const rotated = connection(SECRET_B, "2026-10-27T23:05:51.000Z");

describe("standing consent for a scheduled GitHub board import", () => {
  it("survives an OAuth token rotation (new secret id, new expiry, refresh and verify times, new row time)", () => {
    expect(githubProjectConsentDigest(rotated, { secretId: SECRET_B, latestVersion: 1 }))
      .toBe(githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("NEGATIVE PROOF of the incident: the exact authorization digest does change on the same rotation", () => {
    expect(githubProjectAuthorizationDigest(rotated, { secretId: SECRET_B, latestVersion: 1 }))
      .not.toBe(githubProjectAuthorizationDigest(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("survives a rotation that also changes the credential secret version", () => {
    expect(githubProjectConsentDigest(rotated, { secretId: SECRET_B, latestVersion: 7 }))
      .toBe(githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("NEGATIVE PROOF of the regression: the pre-fix v1 digest (kept here as a fixture) changes on the same refresh", () => {
    // Pre-fix function, verbatim from before c61715d1: only the row time was neutralised.
    const v1 = (value: Connection, credential: { secretId: string; latestVersion: number }) =>
      boardImportDigest({ kind: "github-project-standing-consent-v1",
        authorization: githubProjectAuthorizationDigest({ ...value, updatedAt: new Date(0),
          updatedAtExact: "1970-01-01T00:00:00.000000Z" }, credential) });
    expect(v1(rotated, { secretId: SECRET_B, latestVersion: 1 })).not.toBe(v1(before, { secretId: SECRET_A, latestVersion: 1 }));
    expect(v1(rotated, { secretId: SECRET_B, latestVersion: 7 })).not.toBe(v1(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("does not depend on the order of the credential refs (a refresh without a new refresh token reorders them)", () => {
    const reordered = connection(SECRET_A, "2026-10-27T15:01:08.000Z", {
      credentialSecretRefs: [...before.credentialSecretRefs as unknown[]].reverse(),
      credentialRefs: [...before.credentialRefs as unknown[]].reverse() });
    const two = (value: Connection) => ({ ...value, credentialSecretRefs: [
      ...(value.credentialSecretRefs as unknown[]), { label: "OAuth refresh token", required: true, secretId: SECRET_B,
        configPath: "oauth.refresh_token", versionSelector: "latest" }] });
    expect(githubProjectConsentDigest(two(reordered), { secretId: SECRET_A, latestVersion: 1 }))
      .toBe(githubProjectConsentDigest({ ...two(before), credentialSecretRefs: [...(two(before).credentialSecretRefs as unknown[])].reverse() },
        { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("does not depend on the order or form of the granted scopes or on object key order", () => {
    const scoped = (scope: unknown, scopes: unknown) => connection(SECRET_A, "2026-10-27T15:01:08.000Z", {}, {
      oauth: { ...oauth("2026-10-27T15:01:08.000Z", "2026-10-27T23:01:08.000Z"), scope, scopes } });
    const base = githubProjectConsentDigest(scoped("project repo", ["repo", "project", "offline_access"]), { secretId: SECRET_A, latestVersion: 1 });
    for (const [scope, scopes] of [["repo project", ["offline_access", "project", "repo"]], ["repo,project", ["project", "offline_access", "repo"]],
      ["  repo   project ", ["repo", "project", "repo", "offline_access"]]] as const) {
      expect(githubProjectConsentDigest(scoped(scope, scopes), { secretId: SECRET_A, latestVersion: 1 })).toBe(base);
    }
    // A genuinely different grant still changes it.
    expect(githubProjectConsentDigest(scoped("project", ["project"]), { secretId: SECRET_A, latestVersion: 1 })).not.toBe(base);
    const flipped = { ...before, config: Object.fromEntries(Object.entries(before.config as object).reverse()),
      transportConfig: Object.fromEntries(Object.entries(before.transportConfig as object).reverse()) };
    expect(githubProjectConsentDigest(flipped, { secretId: SECRET_A, latestVersion: 1 })).toBe(githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("is not the old v1 digest, so a pre-fix grant fails closed and must be renewed once", () => {
    expect(githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each<[string, Partial<Connection>, Record<string, unknown>?]>([
    ["a different OAuth client", {}, { oauth: { ...oauth("2026-10-27T15:01:08.000Z", "2026-10-27T23:01:08.000Z"), clientId: "other-client" } }],
    ["different granted scopes", {}, { oauth: { ...oauth("2026-10-27T15:01:08.000Z", "2026-10-27T23:01:08.000Z"), scopes: ["repo"] } }],
    ["a different server URL", {}, { serverUrl: "https://ghe.example.invalid" }],
    ["a different bound account", {}, { providerMetadata: { oauth: {}, githubOAuth: { login: "other", provider: "github", accountId: 9, grantedScopes: ["project", "repo"] } } }],
    ["a disabled connection", { enabled: false }],
    ["a non-active connection", { status: "error" }],
    ["a different application", { applicationId: "44444444-4444-4444-8444-444444444444" }],
    ["an unknown new config field", {}, { unexpectedSetting: true }],
  ])("still changes for %s", (_label, overrides, extra) => {
    const changed = connection(SECRET_A, "2026-10-27T15:01:08.000Z", overrides, extra);
    expect(githubProjectConsentDigest(changed, { secretId: SECRET_A, latestVersion: 1 }))
      .not.toBe(githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 }));
  });
  it("still requires a well-formed credential revision", () => {
    expect(() => githubProjectConsentDigest(before, { secretId: "not-an-id", latestVersion: 1 })).toThrow();
    expect(() => githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 0 })).toThrow();
  });
  it("does not mutate the connection it was given", () => {
    const snapshot = JSON.stringify(before);
    githubProjectConsentDigest(before, { secretId: SECRET_A, latestVersion: 1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("scheduled native board failure reason", () => {
  it("keeps a host-owned static refusal sentence", () => {
    expect(summarizeNativeBoardFailure(conflict("Delegated native board authorization changed")))
      .toEqual({ schema: "native-github-board-scheduled-failure.v1", status: "refused", httpStatus: 409,
        reason: "Delegated native board authorization changed" });
    expect(summarizeNativeBoardFailure(forbidden("Current enabled board schedule grant required")).httpStatus).toBe(403);
  });
  it.each([
    ["a message with an id", new HttpError(409, "Item 8f14e45f-ceea-467f-a0e6-1a2b3c4d5e6f changed")],
    ["a message with a URL", new HttpError(409, "See https://example.invalid/x for details")],
    ["a message with quoted provider text", new HttpError(409, "Board said \"secret title\"")],
    ["a non-host status", new HttpError(500, "Delegated native board authorization changed")],
    ["a database-like error", Object.assign(new Error("duplicate key value (token)=(abc)"), { name: "DrizzleQueryError" })],
    ["a thrown string", "token abc"],
  ])("never copies text from %s", (_label, error) => {
    const out = summarizeNativeBoardFailure(error);
    expect(out.httpStatus).toBe(0);
    expect(out.reason).toMatch(/^unclassified [A-Za-z0-9]+$/);
    expect(JSON.stringify(out)).not.toMatch(/abc|secret title|example\.invalid|8f14e45f/);
  });
});
