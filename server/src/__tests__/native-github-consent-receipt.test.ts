import { describe, expect, it } from "vitest";
import { recordNativeGitHubConsent, verifyNativeGitHubConsent } from "../services/native-github-consent-receipt.js";
import { githubProjectAuthorizationDigest, githubProjectConsentDigest } from "../services/github-oauth-project-page.js";

const ZERO = "00000000-0000-4000-8000-000000000000";
const SECRET = "11111111-1111-4111-8111-111111111111";
const account = { accountId: 1001, login: "Example" };
const credential = { secretId: SECRET, latestVersion: 3 };
const config = {
  oauth: { scope: "project repo", scopes: ["repo", "project"], clientId: "synthetic-client", provider: "github",
    tokenUrl: "https://github.com/login/oauth/access_token", expiresAt: "2026-01-02T00:00:00.000Z", grantType: "authorization_code",
    connectedAt: "2026-01-01T00:00:00.000Z", refreshedAt: "2026-01-01T00:00:00.000Z", authorizationUrl: "https://github.com/login/oauth/authorize" },
  methodKey: "rest-oauth", serverUrl: "https://api.github.com",
};
const connection = {
  id: ZERO, companyId: ZERO, applicationId: ZERO, updatedAt: new Date("2026-01-01T00:00:00.000Z"), transport: "rest_api",
  authKind: "oauth", status: "active", enabled: true, ownership: "customer", config, transportConfig: config,
  credentialSecretRefs: [], credentialRefs: [],
} as never;

/** Minimal query-builder fake: every chain resolves to the given rows. */
function fakeExecutor(rows: unknown[], inserted: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "from", "where", "orderBy", "for", "limit"]) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown[]) => void) => resolve(rows);
  return {
    select: () => chain,
    insert: () => ({ values: (value: unknown) => { inserted.push(value); return Promise.resolve(); } }),
  } as never;
}

describe("recordNativeGitHubConsent", () => {
  it("writes a receipt bound to the user, account and credential revision", async () => {
    const inserted: Record<string, unknown>[] = [];
    await recordNativeGitHubConsent(fakeExecutor([{ latestVersion: 3 }], inserted as never), connection, "user-example", account, SECRET);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ actorType: "user", actorId: "user-example", responsibleUserId: "user-example",
      action: "github_native_oauth.consent_verified", entityType: "tool_connection" });
    expect((inserted[0].details as Record<string, unknown>).login).toBe("example");
  });

  it("refuses when the access credential is not active", async () => {
    await expect(recordNativeGitHubConsent(fakeExecutor([]), connection, "user-example", account, SECRET)).rejects.toThrow();
  });
});

describe("verifyNativeGitHubConsent", () => {
  const consentRevision = githubProjectConsentDigest(connection, credential);
  const receipt = (over: Record<string, unknown> = {}) => ({
    actorType: "user", actorId: "user-example", responsibleUserId: "user-example", createdAt: new Date("2026-01-01T00:00:00.000Z"),
    details: { schema: 1, applicationId: ZERO, accountId: 1001, login: "example", consentRevision }, ...over,
  });

  it("returns the authorization digest for the matching user and credential", async () => {
    const result = await verifyNativeGitHubConsent(fakeExecutor([receipt()]), connection, "user-example", account, credential);
    expect(result).toEqual({ oauthUserId: "user-example", accountId: 1001, login: "Example", connectionId: ZERO,
      authorizationRevision: githubProjectAuthorizationDigest(connection, credential) });
  });

  it("returns null when there is no receipt or it belongs to another user", async () => {
    expect(await verifyNativeGitHubConsent(fakeExecutor([]), connection, "user-example", account, credential)).toBeNull();
    expect(await verifyNativeGitHubConsent(fakeExecutor([receipt({ actorId: "someone-else" })]), connection, "user-example", account, credential)).toBeNull();
  });

  it("keeps the same consent across a routine token rotation but yields a new authorization digest", async () => {
    const rotated = { secretId: SECRET, latestVersion: 4 };
    const result = await verifyNativeGitHubConsent(fakeExecutor([receipt()]), connection, "user-example", account, rotated);
    expect(result?.authorizationRevision).toBe(githubProjectAuthorizationDigest(connection, rotated));
    expect(result?.authorizationRevision).not.toBe(githubProjectAuthorizationDigest(connection, credential));
  });

  it("returns null when the GitHub account changed or two receipts share a timestamp", async () => {
    expect(await verifyNativeGitHubConsent(fakeExecutor([receipt()]), connection, "user-example", { accountId: 2002, login: "Example" }, credential)).toBeNull();
    expect(await verifyNativeGitHubConsent(fakeExecutor([receipt()]), connection, "user-example", { accountId: 1001, login: "other" }, credential)).toBeNull();
    expect(await verifyNativeGitHubConsent(fakeExecutor([receipt(), receipt()]), connection, "user-example", account, credential)).toBeNull();
  });
});
