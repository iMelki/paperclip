import { describe, expect, it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { getAvailableConnectionMethod } from "./app-definitions.js";
import { appDefinitionSchema } from "./validators/app-definition.js";
import type { AppDefinition } from "./types/app-definition.js";
import {
  GITHUB_OAUTH_API_URL,
  GITHUB_OAUTH_AUTHORIZATION_URL,
  GITHUB_OAUTH_METHOD_KEY,
  GITHUB_OAUTH_TOKEN_URL,
  GITHUB_OAUTH_USER_URL,
  GitHubOAuthValidationError,
  createGitHubOAuthProviderConfig,
  getGitHubOAuthConnectionMethod,
  verifyGitHubOAuthExpiry,
  verifyGitHubOAuthGrant,
} from "./github-oauth.js";

const account = { id: 42, login: "test-operator", type: "User" };
const github = () => structuredClone(APP_DEFINITIONS.find((app) => app.slug === "github")!);
const grant = (overrides: Partial<Parameters<typeof verifyGitHubOAuthGrant>[0]> = {}) => ({
  account,
  expectedLogin: "test-operator",
  grantedScopes: "repo,project",
  ...overrides,
});

function expectRefusal(action: () => unknown, code: string) {
  expect(action).toThrowError(GitHubOAuthValidationError);
  expect(action).toThrowError(code);
}

describe("dedicated GitHub OAuth provider metadata", () => {
  it("uses fixed GitHub endpoints and requests RW scopes plus expiring-token support", () => {
    expect(createGitHubOAuthProviderConfig(" synthetic-client ")).toEqual({
      provider: "github",
      clientId: "synthetic-client",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project", "offline_access"],
    });
    expect(GITHUB_OAUTH_API_URL).toBe("https://api.github.com");
    expect(GITHUB_OAUTH_USER_URL).toBe("https://api.github.com/user");
  });

  it.each(["", " ", "bad\nclient", "client?secret=value", "x".repeat(129), "github_pat_synthetic", "gho_synthetic", null])(
    "refuses invalid public client metadata without reflecting it: %s", (value) => {
      expectRefusal(() => createGitHubOAuthProviderConfig(value as string), "github_oauth_client_id_invalid");
    },
  );

  it("creates fresh scope arrays without secrets, agent grants, or sync instructions", () => {
    const first = createGitHubOAuthProviderConfig("synthetic-client");
    first.scopes.push("delete_repo");
    const next = createGitHubOAuthProviderConfig("synthetic-client");
    expect(next.scopes).toEqual(["repo", "project", "offline_access"]);
    expect(Object.keys(next).sort()).toEqual(["authorizationUrl", "clientId", "provider", "scopes", "tokenUrl"]);
  });

  it("appends a valid customer OAuth method without replacing the existing token default", () => {
    const definition = github();
    expect(() => appDefinitionSchema.parse(definition)).not.toThrow();
    expect(getAvailableConnectionMethod(definition)?.key).toBe("mcp-key");
    const method = getGitHubOAuthConnectionMethod(definition)!;
    expect(definition.methods.at(-1)?.key).toBe(GITHUB_OAUTH_METHOD_KEY);
    expect(method.ownershipModes).toEqual(["customer"]);
    expect(method.defaults?.scopesHint).toEqual(["repo", "project", "offline_access"]);
    expect(method.credentialFields?.map((field) => [field.key, field.secret])).toEqual([
      ["clientId", false], ["clientSecret", true],
    ]);
    expect(method.warnings?.join(" ")).toContain("No import or agent run");
    expect(method.defaults?.authorizationEndpoint).toBe(GITHUB_OAUTH_AUTHORIZATION_URL);
    expect(method.defaults?.tokenEndpoint).toBe(GITHUB_OAUTH_TOKEN_URL);
  });

  it.each([
    (app: AppDefinition) => { app.slug = "foreign"; },
    (app: AppDefinition) => { app.ownershipAvailability = { customer: false }; },
    (app: AppDefinition) => { app.methods = app.methods.filter((method) => method.key !== GITHUB_OAUTH_METHOD_KEY); },
    (app: AppDefinition) => { app.methods.push(structuredClone(app.methods.at(-1)!)); },
    (app: AppDefinition) => { app.methods.at(-1)!.auth = "api_key"; },
    (app: AppDefinition) => { app.methods.at(-1)!.transport = "mcp_remote"; },
    (app: AppDefinition) => { app.methods.at(-1)!.ownershipModes.push("dcr"); },
    (app: AppDefinition) => { app.methods.at(-1)!.defaults!.serverUrl = "https://api.github.com.evil.test"; },
    (app: AppDefinition) => { app.methods.at(-1)!.defaults!.authorizationEndpoint += "?redirect_uri=evil"; },
    (app: AppDefinition) => { app.methods.at(-1)!.defaults!.tokenEndpoint += "/"; },
    (app: AppDefinition) => { app.methods.at(-1)!.defaults!.scopesHint = ["repo", "read:project", "offline_access"]; },
    (app: AppDefinition) => { app.methods.at(-1)!.defaults!.scopesHint!.push("delete_repo"); },
  ])("does not select an altered or ambiguous OAuth catalog method %#", (mutate) => {
    const app = github();
    mutate(app);
    expect(getGitHubOAuthConnectionMethod(app)).toBeNull();
  });

  it("does not mutate the catalog when selecting a method", () => {
    const app = github();
    const before = structuredClone(app);
    expect(getGitHubOAuthConnectionMethod(app)?.key).toBe(GITHUB_OAUTH_METHOD_KEY);
    expect(app).toEqual(before);
  });
});

describe("actual GitHub OAuth grant verification", () => {
  it("retains raw scope evidence and stable identity without profile or token fields", () => {
    const raw = " repo,\tproject\nrepo, read:org ";
    expect(verifyGitHubOAuthGrant(grant({ grantedScopes: raw, expectedAccountId: 42 }))).toEqual({
      provider: "github", accountId: 42, login: "test-operator",
      rawGrantedScopes: raw, grantedScopes: ["repo", "project", "read:org"],
    });
  });

  it("accepts case-insensitive account identity, not case-insensitive scope names", () => {
    expect(verifyGitHubOAuthGrant(grant({ expectedLogin: "TEST-OPERATOR" })).accountId).toBe(42);
    expectRefusal(() => verifyGitHubOAuthGrant(grant({ grantedScopes: "Repo,project" })), "github_oauth_scopes_insufficient");
  });

  it("does not require offline_access in actual granted scope metadata", () => {
    expect(verifyGitHubOAuthGrant(grant()).grantedScopes).toEqual(["repo", "project"]);
  });

  it.each(["", "repo", "project", "repo,read:project", "public_repo,project", "myrepo,project", "repo,project_extra"])(
    "refuses missing exact RW grants: %s", (scopes) => {
      expectRefusal(() => verifyGitHubOAuthGrant(grant({ grantedScopes: scopes })), "github_oauth_scopes_insufficient");
    },
  );

  it.each([null, undefined, ["repo", "project"], 12, "repo,project\0", "repo,project,é", "repo,project,\"secret\"", "x".repeat(4097), Array(129).fill("repo").join(",")])(
    "refuses malformed actual granted scope evidence %#", (scopes) => {
      expectRefusal(() => verifyGitHubOAuthGrant(grant({ grantedScopes: scopes })), "github_oauth_scope_metadata_invalid");
    },
  );

  it.each([null, [], {}, { ...account, id: "42" }, { ...account, id: 0 }, { ...account, id: -1 },
    { ...account, id: 1.2 }, { ...account, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...account, login: "-bad" }, { ...account, login: "bad-" }, { ...account, login: "bad name" },
    { ...account, type: "Organization" }, { ...account, type: "Bot" }])(
    "refuses missing or malformed server-read user identity %#", (value) => {
      expectRefusal(() => verifyGitHubOAuthGrant(grant({ account: value })), "github_oauth_account_invalid");
    },
  );

  it.each([{ expectedLogin: "someone-else" }, { expectedAccountId: 43 }])(
    "refuses a different account even when one identity attribute matches %#", (identity) => {
      expectRefusal(() => verifyGitHubOAuthGrant(grant(identity)), "github_oauth_account_mismatch");
    },
  );

  it.each([{ expectedLogin: "" }, { expectedLogin: " test-operator " }, { expectedAccountId: 0 }, { expectedAccountId: NaN }])(
    "refuses invalid expected account metadata before reading scopes %#", (identity) => {
      expectRefusal(() => verifyGitHubOAuthGrant(grant(identity)), "github_oauth_account_invalid");
    },
  );

  it("does not mutate the input or reflect unexpected account fields in facts", () => {
    const input = grant({ account: { ...account, email: "private@synthetic.test", token: "synthetic-secret" } });
    const before = structuredClone(input);
    const facts = verifyGitHubOAuthGrant(input);
    expect(input).toEqual(before);
    expect(JSON.stringify(facts)).not.toContain("private@synthetic.test");
    expect(JSON.stringify(facts)).not.toContain("synthetic-secret");
  });

  it("keeps error messages credential-redacted", () => {
    const secret = "synthetic-secret?token=value";
    try {
      verifyGitHubOAuthGrant(grant({ grantedScopes: secret }));
      throw new Error("expected validation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOAuthValidationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("GitHub expiring-token lifecycle metadata", () => {
  it("returns only a validated finite expiry, never a refresh credential", () => {
    expect(verifyGitHubOAuthExpiry({ expiresIn: 28800, refreshToken: "synthetic-refresh" })).toEqual({ expiresIn: 28800 });
  });

  it.each([undefined, null, "28800", 0, -1, 0.5, NaN, Infinity, 86401, Number.MAX_SAFE_INTEGER + 1])(
    "refuses absent or invalid access expiry %#", (expiresIn) => {
      expectRefusal(() => verifyGitHubOAuthExpiry({ expiresIn, refreshToken: "synthetic-refresh" }), "github_oauth_expiry_invalid");
    },
  );

  it.each([undefined, null, 12, "", " ", " refresh ", "refresh\n", "x".repeat(4097)])(
    "requires an opaque nonempty refresh credential without returning it %#", (refreshToken) => {
      expectRefusal(() => verifyGitHubOAuthExpiry({ expiresIn: 28800, refreshToken }), "github_oauth_refresh_missing");
    },
  );
});
