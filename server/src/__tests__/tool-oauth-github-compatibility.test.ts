import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { exchangeOAuthToken, normalizeOauthScopes } from "../services/tool-access.js";

const githubTokenUrl = "https://github.com/login/oauth/access_token";
const input = {
  tokenUrl: githubTokenUrl,
  clientId: "synthetic-client-id",
  clientSecret: "synthetic-client-secret",
  code: "synthetic+code&value",
  codeVerifier: "synthetic-pkce-verifier",
  redirectUri: "https://app.example.test/api/tools/oauth/callback",
};
const tokenPayload = {
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-token",
  expires_in: 28800,
  token_type: "bearer",
  scope: "repo,read:project",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub OAuth token exchange compatibility", () => {
  it("requests JSON and preserves the encoded authorization-code and PKCE fields", async () => {
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      // GitHub's default is form encoded: this fixture only emits JSON when explicitly requested.
      return headers.get("accept") === "application/json"
        ? jsonResponse(tokenPayload)
        : new Response("access_token=synthetic-access-token&scope=repo%2Cread%3Aproject");
    });
    const result = await exchangeOAuthToken(input, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe(githubTokenUrl);
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = request?.body as URLSearchParams;
    expect(Object.fromEntries(body.entries())).toEqual({
      grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier, client_id: input.clientId, client_secret: input.clientSecret,
    });
    expect(body.toString()).toContain("code=synthetic%2Bcode%26value");
    expect(result).toMatchObject({
      accessToken: tokenPayload.access_token, refreshToken: tokenPayload.refresh_token,
      expiresIn: 28800, tokenType: "bearer", scope: "repo read:project",
    });
    expect(result.raw.scope).toBe("repo,read:project");
  });

  it.each([200, 400, 401])("rejects GitHub error JSON at HTTP %i without accepting a coincident token", async status => {
    const transport = vi.fn(async () => jsonResponse({
      error: "bad_verification_code", error_description: "Synthetic code expired", access_token: "synthetic-ignored-token",
    }, status));
    await expect(exchangeOAuthToken(input, transport)).rejects.toMatchObject({
      status: 502, details: { code: "oauth_token_exchange_failed", providerError: "bad_verification_code", status },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, "", " \t\r\n", 123])("rejects absent or invalid access token %s", async access_token => {
    await expect(exchangeOAuthToken(input, async () => jsonResponse({ access_token }))).rejects.toMatchObject({
      status: 502, details: { code: "oauth_access_token_missing" },
    });
  });

  it("rejects an unexpected form-encoded response rather than treating it as JSON success", async () => {
    await expect(exchangeOAuthToken(input, async () => new Response("access_token=synthetic-token")))
      .rejects.toMatchObject({ details: { code: "oauth_access_token_missing" } });
  });

  it("preserves existing refresh invalid_grant reauthorization semantics", async () => {
    const transport = vi.fn(async (_url: string, _request?: RequestInit) => jsonResponse({ error: "invalid_grant" }, 200));
    await expect(exchangeOAuthToken({ ...input, grantType: "refresh_token", refreshToken: "synthetic-old-refresh" }, transport))
      .rejects.toMatchObject({ status: 422, details: { code: "oauth_reauthorization_required" } });
    const body = transport.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("synthetic-old-refresh");
  });

  it.each([200, 400])("requires reauthorization for terminal GitHub bad_refresh_token at HTTP %i", async status => {
    const transport = vi.fn(async () => jsonResponse({ error: "bad_refresh_token" }, status));
    await expect(exchangeOAuthToken({ ...input, grantType: "refresh_token", refreshToken: "synthetic-expired-refresh" }, transport))
      .rejects.toMatchObject({
        status: 422,
        details: { code: "oauth_reauthorization_required", providerError: "bad_refresh_token", status },
      });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tokenUrl: "https://oauth.example.test/token", status: 200 },
    { tokenUrl: "https://oauth.example.test/token", status: 400 },
    { tokenUrl: "https://github.com.evil.test/login/oauth/access_token", status: 200 },
    { tokenUrl: "https://github.com.evil.test/login/oauth/access_token", status: 400 },
  ])("does not make another provider's bad_refresh_token terminal: $tokenUrl HTTP $status", async ({ tokenUrl, status }) => {
    await expect(exchangeOAuthToken({ ...input, tokenUrl, grantType: "refresh_token", refreshToken: "synthetic-refresh" },
      async () => jsonResponse({ error: "bad_refresh_token" }, status))).rejects.toMatchObject({
      status: 502,
      details: { code: "oauth_token_exchange_failed", providerError: "bad_refresh_token", status },
    });
  });

  it.each(["authorization_code", "client_credentials"] as const)
    ("does not treat GitHub bad_refresh_token as refresh failure during %s", async grantType => {
      await expect(exchangeOAuthToken({ ...input, grantType }, async () => jsonResponse({ error: "bad_refresh_token" })))
        .rejects.toMatchObject({ status: 502, details: { code: "oauth_token_exchange_failed" } });
    });

  it.each([200, 400])("preserves non-GitHub invalid_grant refresh behavior at HTTP %i", async status => {
    await expect(exchangeOAuthToken({
      ...input, tokenUrl: "https://oauth.example.test/token", grantType: "refresh_token", refreshToken: "synthetic-refresh",
    }, async () => jsonResponse({ error: "invalid_grant" }, status))).rejects.toMatchObject({
      status: 422, details: { code: "oauth_reauthorization_required", providerError: "invalid_grant", status },
    });
  });

  it("keeps refresh and client-credentials request shapes for other providers", async () => {
    const requests: URLSearchParams[] = [];
    const transport = async (_url: string, request?: RequestInit) => {
      requests.push(request?.body as URLSearchParams);
      return jsonResponse({ ...tokenPayload, expires_in: "3600", scope: "urn:opaque,scope files:read" });
    };
    const other = { ...input, tokenUrl: "https://oauth.example.test/token" };
    const refreshed = await exchangeOAuthToken({ ...other, grantType: "refresh_token", refreshToken: "synthetic-old-refresh" }, transport);
    const machine = await exchangeOAuthToken({ ...other, grantType: "client_credentials", scopes: ["files:read", "files:write"] }, transport);
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("synthetic-old-refresh");
    expect(requests[0]?.has("code")).toBe(false);
    expect(requests[1]?.get("grant_type")).toBe("client_credentials");
    expect(requests[1]?.get("scope")).toBe("files:read files:write");
    expect(requests[1]?.has("redirect_uri")).toBe(false);
    expect(refreshed.scope).toBe("urn:opaque,scope files:read");
    expect(machine.expiresIn).toBe(3600);
  });

  it.each([
    "https://github.com.evil.test/login/oauth/access_token",
    "https://oauth.example.test/github/login/oauth/access_token",
    "https://github.com/login/oauth/access_token?provider=github",
  ])("does not apply GitHub CSV rules to a different endpoint: %s", async tokenUrl => {
    const result = await exchangeOAuthToken({ ...input, tokenUrl }, async () => jsonResponse(tokenPayload));
    expect(result.scope).toBe("repo,read:project");
  });

  it("retains provider scope absence and empty GitHub scope without inventing permissions", async () => {
    const absent = await exchangeOAuthToken(input, async () => jsonResponse({ access_token: "synthetic-token" }));
    const empty = await exchangeOAuthToken(input, async () => jsonResponse({ access_token: "synthetic-token", scope: "" }));
    expect(absent.scope).toBeNull();
    expect(empty.scope).toBe("");
  });

  it("propagates transport failure without retrying or inventing a token", async () => {
    const transport = vi.fn(async () => { throw new Error("synthetic transport failure"); });
    await expect(exchangeOAuthToken(input, transport)).rejects.toThrow("synthetic transport failure");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("service callback and refresh use the guarded transport, not an unguarded fetch fallback", () => {
    const source = readFileSync(new URL("../services/tool-access.ts", import.meta.url), "utf8");
    expect(source).toContain("}, fetchRemoteHttpUrl);");
    const exchanges = [...source.matchAll(/token = await exchangeOAuthToken\(\{[\s\S]*?\}, (\w+)\);/g)];
    expect(exchanges.map((match) => match[1])).toEqual(["fetchRemoteHttpUrl", "fetchRemoteHttpUrl"]);
    expect(source).toContain("redirect: \"manual\"");
    expect(source).toContain("assertPublicRemoteHttpEndpoint(");
  });
});

describe("provider-aware OAuth scope normalization", () => {
  it.each([
    ["repo,read:project", ["repo", "read:project"]],
    [" repo , read:project\t repo\n", ["repo", "read:project"]],
    ["read:project repo", ["read:project", "repo"]],
    [", \t\r\n,", []],
  ])("normalizes GitHub commas/ASCII whitespace exactly: %s", (value, expected) => {
    expect(normalizeOauthScopes(value, true)).toEqual(expected);
  });

  it("preserves exact scope identities without granting a broader scope or case alias", () => {
    const scopes = normalizeOauthScopes("read:project,Repo,repo:status,unknown:scope", true);
    expect(scopes).toEqual(["read:project", "Repo", "repo:status", "unknown:scope"]);
    expect(scopes).not.toContain("project");
    expect(scopes).not.toContain("repo");
  });

  it("deduplicates atomic GitHub array entries without splitting compound array grants", () => {
    expect(normalizeOauthScopes(["repo", " read:project ", "repo", "", "\t"], true)).toEqual(["repo", "read:project"]);
  });

  it.each([
    { value: ["repo read:project"] }, { value: ["repo,read:project"] }, { value: ["repo", null] },
    { value: ["read:project\u0000project"] }, { value: ["read:project\u00a0project"] },
    { value: ["\"read:project\""] }, { value: ["repo\\project"] },
  ])("rejects malformed/compound GitHub scope array $value", ({ value }) => {
    expect(() => normalizeOauthScopes(value, true)).toThrow("malformed scope token");
  });

  it("preserves existing generic provider parsing and opaque comma-bearing scope tokens", () => {
    expect(normalizeOauthScopes("urn:opaque,scope files:read")).toEqual(["urn:opaque,scope", "files:read"]);
    expect(normalizeOauthScopes([" read:files ", 7, "", "urn:opaque,scope"]))
      .toEqual([" read:files ", "urn:opaque,scope"]);
    expect(normalizeOauthScopes(undefined)).toEqual([]);
  });

  it("has zero generic-provider drift against the prior parser over a mixed scope corpus", () => {
    const before = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      return typeof value === "string" ? value.split(/\s+/).map((item) => item.trim()).filter(Boolean) : [];
    };
    const corpus: unknown[] = [undefined, null, 7, [], ["scope", "", 7], "", "urn:opaque,scope", "files:read files:write"];
    for (const prefix of ["", " ", "\t"]) {
      for (const scope of ["read:project", "repo:status", "Repo", "urn:opaque,scope", "S256", "client_secret_post"]) {
        corpus.push(prefix + scope + " files:read\n", [prefix + scope, scope]);
      }
    }
    const changed = corpus.filter(value => JSON.stringify(before(value)) !== JSON.stringify(normalizeOauthScopes(value)));
    expect(changed).toEqual([]);
    // This control differs against the old parser: the comparison cannot always report zero.
    expect(before("repo,read:project")).not.toEqual(normalizeOauthScopes("repo,read:project", true));
  });
});
