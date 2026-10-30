import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  GitHubOAuthTransportError,
  executeGitHubOAuthTool,
  getGitHubOAuthToolDescriptor,
  githubOAuthToolDescriptors,
  isNativeGitHubOAuthConnection,
  verifyGitHubOAuthAccount,
  verifyGitHubOAuthAuthorization,
} from "../services/github-oauth-transport.js";
import type { GitHubGuardedFetch } from "../services/github-oauth-transport.js";

const headers = { Authorization: "Bearer synthetic-access" };
const user = { id: 42, login: "test-operator", type: "User" };
const authorization = () => ({ accessToken: "synthetic-access", scope: "repo,project",
  expiresIn: 28800, refreshToken: "synthetic-refresh", expectedLogin: "test-operator", expectedAccountId: 42, privateRepoAccess: true });
const config = () => ({ sourceTemplateKey: "github", serverUrl: "https://api.github.com", methodKey: "rest-oauth", oauth: {
  provider: "github", authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
} });
function harness(response: Response | (() => Response) = () => Response.json(user, { headers: { "X-OAuth-Scopes": "repo,project" } })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: GitHubGuardedFetch = async (url, init = {}) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { calls, fetch };
}
const execute = (toolName: string, args: unknown, fetch: GitHubGuardedFetch, timeoutMs?: number) =>
  executeGitHubOAuthTool({ toolName, arguments: args, headers, timeoutMs }, fetch);
const body = (call: { init: RequestInit }) => JSON.parse(call.init.body as string);
function fileWriteResponse(bytes = Buffer.from("test")) {
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { content: { type: "file", path: "docs/example.md", sha, size: bytes.length,
    git_url: `https://api.github.com/repos/test-operator/synthetic-repo/git/blobs/${sha}`,
    html_url: "https://github.com/test-operator/synthetic-repo/blob/topic/synthetic/docs/example.md" },
  commit: { sha: "c".repeat(40), url: `https://api.github.com/repos/test-operator/synthetic-repo/git/commits/${"c".repeat(40)}` } };
}
function projectItem(overrides: Record<string, unknown> = {}) {
  return { id: "PVTI_synthetic", type: "ISSUE", isArchived: false,
    project: { id: "PVT_synthetic" }, content: { __typename: "Issue", id: "ISSUE_synthetic" }, ...overrides };
}

describe("native GitHub OAuth connection discrimination", () => {
  it("accepts only the exact persisted OAuth method and vendor endpoints", () => {
    const value = config();
    expect(isNativeGitHubOAuthConnection({ transport: "rest_api", authKind: "oauth", config: value, transportConfig: value })).toBe(true);
    expect(isNativeGitHubOAuthConnection({ transport: "rest_api", config: value })).toBe(true);
  });

  it.each([
    { transport: "mcp_remote" }, { authKind: "api_key" }, { authKind: null }, { config: null },
    { config: { ...config(), methodKey: "mcp-key" } },
    { config: { ...config(), sourceTemplateKey: "foreign" } },
    { config: { ...config(), serverUrl: "https://api.github.com.evil.test" } },
    { config: { ...config(), serverUrl: "https://api.github.com/" } },
    { config: { ...config(), oauth: { ...config().oauth, provider: "foreign" } } },
    { config: { ...config(), oauth: { ...config().oauth, tokenUrl: "https://evil.test/token" } } },
    { config: { ...config(), oauth: { ...config().oauth, authorizationUrl: "https://github.com/login/oauth/authorize?x=y" } } },
    { transportConfig: { ...config(), methodKey: "foreign" } },
    { transportConfig: { ...config(), sourceTemplateKey: "foreign" } }, { transportConfig: {} },
  ])("rejects forged, ambiguous, or mismatched transport metadata %#", (change) => {
    expect(isNativeGitHubOAuthConnection({ transport: "rest_api", authKind: "oauth", config: config(), ...change })).toBe(false);
  });

  it("does not mutate stored configuration", () => {
    const value = config();
    const before = structuredClone(value);
    isNativeGitHubOAuthConnection({ transport: "rest_api", config: value });
    expect(value).toEqual(before);
  });
});

describe("fixed GitHub authenticated-account proof", () => {
  it("verifies actual user identity/scopes with one bounded GET and no unsafe caller headers", async () => {
    const io = harness();
    const facts = await verifyGitHubOAuthAuthorization(authorization(), io.fetch);
    expect(facts).toEqual({ provider: "github", accountId: 42, login: "test-operator",
      rawGrantedScopes: "repo,project", grantedScopes: ["repo", "project"],
      rawTokenGrantedScopes: "repo,project", tokenGrantedScopes: ["repo", "project"] });
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0].url).toBe("https://api.github.com/user");
    expect(io.calls[0].init.method).toBe("GET");
    expect(io.calls[0].init.redirect).toBe("manual");
    expect(io.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(io.calls[0].init.headers).toMatchObject({ Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10", Authorization: headers.Authorization });
    expect(JSON.stringify(facts)).not.toContain("synthetic-access");
    expect(JSON.stringify(facts)).not.toContain("synthetic-refresh");
  });

  it("provides health/reconnect account verification without requiring refresh-token access", async () => {
    const io = harness();
    const facts = await verifyGitHubOAuthAccount({ headers: { ...headers, Host: "evil.test", Cookie: "synthetic-cookie" },
      scope: "repo project", expectedLogin: "TEST-OPERATOR", expectedAccountId: 42, privateRepoAccess: true }, io.fetch);
    expect(facts.accountId).toBe(42);
    expect(io.calls[0].init.headers).not.toHaveProperty("Host");
    expect(io.calls[0].init.headers).not.toHaveProperty("Cookie");
  });

  it.each([{ expiresIn: 0 }, { expiresIn: null }, { refreshToken: "" }, { refreshToken: undefined },
    { accessToken: "" }, { accessToken: "secret\nheader" }])(
    "rejects invalid lifecycle/credential input before HTTP dispatch %#", async (change) => {
      const io = harness();
      await expect(verifyGitHubOAuthAuthorization({ ...authorization(), ...change }, io.fetch)).rejects.toThrow();
      expect(io.calls).toHaveLength(0);
    },
  );

  it.each([{ ...user, id: 43 }, { ...user, login: "another-user" }, { ...user, type: "Organization" }, null])(
    "rejects incorrect account readback instead of treating consent as identity proof %#", async (payload) => {
      const io = harness(() => Response.json(payload));
      await expect(verifyGitHubOAuthAuthorization(authorization(), io.fetch)).rejects.toThrow(/github_oauth_account_/);
      expect(io.calls).toHaveLength(1);
    },
  );

  it("rejects insufficient actual grants despite requesting repo/project (explicit private opt-in)", async () => {
    const io = harness();
    await expect(verifyGitHubOAuthAuthorization({ ...authorization(), scope: "repo,read:project", privateRepoAccess: true }, io.fetch))
      .rejects.toThrow("github_oauth_scopes_insufficient");
  });

  it("default tier rejects a grant without public_repo or read:project and accepts least access", async () => {
    await expect(verifyGitHubOAuthAuthorization({ ...authorization(), scope: "read:project" }, harness().fetch))
      .rejects.toThrow("github_oauth_scopes_insufficient");
    const io = harness(() => Response.json(user, { headers: { "X-OAuth-Scopes": "read:project, public_repo" } }));
    const facts = await verifyGitHubOAuthAuthorization({ ...authorization(), scope: "read:project,public_repo", privateRepoAccess: false }, io.fetch);
    expect(facts.grantedScopes).toEqual(["read:project", "public_repo"]);
  });

  it("refuses a public-only connection whose grant is wider than chosen, with an actionable 422", async () => {
    for (const [token, current] of [["repo,project", "repo,project"], ["read:project,public_repo", "read:project,public_repo,repo"]]) {
      const io = harness(() => Response.json(user, { headers: { "X-OAuth-Scopes": current } }));
      const refused = await verifyGitHubOAuthAuthorization({ ...authorization(), scope: token, privateRepoAccess: false }, io.fetch)
        .then(() => null, (error: unknown) => error as { status: number; code: string; message: string });
      expect(refused).toMatchObject({ status: 422, code: "github_oauth_scopes_too_broad" });
      expect(refused!.message).toContain("Include private repositories");
      expect(refused!.message).toContain("revoke");
      expect(refused!.message).not.toContain("synthetic-access");
    }
  });

  it("derives current grant facts from GET/user header and retains original token-response scope separately", async () => {
    const io = harness(() => Response.json(user, { headers: { "X-OAuth-Scopes": "repo,project,repo:status" } }));
    const facts = await verifyGitHubOAuthAuthorization({ ...authorization(), scope: " repo project " }, io.fetch);
    expect(facts.rawGrantedScopes).toBe("repo,project,repo:status");
    expect(facts.grantedScopes).toEqual(["repo", "project", "repo:status"]);
    const orgIo = harness(() => Response.json(user, { headers: { "X-OAuth-Scopes": "repo,project,read:org" } }));
    await expect(verifyGitHubOAuthAuthorization({ ...authorization(), scope: " repo project " }, orgIo.fetch)).rejects.toThrow();
    expect(facts.rawTokenGrantedScopes).toBe(" repo project ");
    expect(facts.tokenGrantedScopes).toEqual(["repo", "project"]);
  });

  it.each([null, "", "repo", "repo,read:project", "project", "public_repo,project", "repo,project,\"invalid\""])(
    "rejects missing, reduced, or malformed current grants despite saved full scopes: %s", async (scope) => {
      const response = scope === null ? Response.json(user) : Response.json(user, { headers: { "X-OAuth-Scopes": scope } });
      const io = harness(response);
      await expect(verifyGitHubOAuthAccount({ headers, scope: "repo,project", expectedLogin: "test-operator", expectedAccountId: 42,
        privateRepoAccess: true }, io.fetch))
        .rejects.toThrow(/github_oauth_scope/);
      expect(io.calls).toHaveLength(1);
    },
  );

  it("does not replace absent original grant evidence with a current full-permission header", async () => {
    const io = harness();
    await expect(verifyGitHubOAuthAuthorization({ ...authorization(), scope: undefined }, io.fetch))
      .rejects.toThrow("github_oauth_scope_metadata_invalid");
  });

  it.each([{ scope: ["repo", "project"] }, { scope: "read:project" },
    { expiresIn: 86401 }, { refreshToken: "" }])("surfaces safe actionable validation errors as HTTP 422 %#", async (change) => {
    const io = harness();
    try {
      await verifyGitHubOAuthAuthorization({ ...authorization(), ...change }, io.fetch);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOAuthTransportError);
      expect((error as GitHubOAuthTransportError).status).toBe(422);
      expect((error as GitHubOAuthTransportError).code).toMatch(/^github_oauth_/);
    }
  });

  it.each([301, 302, 307, 308, 401, 403, 429, 500])("rejects HTTP %i without following or retrying", async (status) => {
    const io = harness(new Response("synthetic-secret error", { status, headers: { location: "https://evil.test" } }));
    await expect(verifyGitHubOAuthAuthorization(authorization(), io.fetch)).rejects.toBeInstanceOf(GitHubOAuthTransportError);
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "1000001" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "invalid" } }),
    () => new Response("x".repeat(1_000_001), { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
  ])("refuses malformed, oversized, or invalid-encoding account responses %#", async (makeResponse) => {
    const io = harness(makeResponse);
    await expect(verifyGitHubOAuthAuthorization(authorization(), io.fetch)).rejects.toBeInstanceOf(GitHubOAuthTransportError);
    expect(io.calls).toHaveLength(1);
  });

  it("rejects a fetch implementation that already followed a redirect", async () => {
    const response = Response.json(user);
    Object.defineProperty(response, "redirected", { value: true });
    const io = harness(response);
    await expect(verifyGitHubOAuthAuthorization(authorization(), io.fetch)).rejects.toThrow("github_redirect_rejected");
  });

  it("redacts thrown fetch details and never retries", async () => {
    let calls = 0;
    const fetch: GitHubGuardedFetch = async () => { calls += 1; throw new Error("synthetic-access private details"); };
    await expect(verifyGitHubOAuthAuthorization(authorization(), fetch)).rejects.toThrow("github_request_failed");
    expect(calls).toBe(1);
  });
});

describe("reviewed static GitHub tool catalog", () => {
  it("lists twelve fixed classified operations without arbitrary query, delete, or admin", () => {
    const entries = githubOAuthToolDescriptors();
    expect(entries.map((entry) => entry.name)).toEqual([
      "github_get_account", "github_list_repositories", "github_list_repository_issues", "github_get_repository_file", "github_list_projects",
      "github_get_project_items", "github_create_or_update_file", "github_create_issue", "github_update_issue",
      "github_update_project", "github_add_project_item", "github_update_project_item_field",
    ]);
    expect(entries.filter((entry) => entry.risk === "read")).toHaveLength(6);
    expect(entries.filter((entry) => entry.risk === "write")).toHaveLength(6);
    for (const entry of entries) {
      expect(entry.annotations.readOnlyHint).toBe(entry.risk === "read");
      expect(entry.annotations.destructiveHint).toBe(false);
      expect(entry.inputSchema.additionalProperties).toBe(false);
    }
    expect(getGitHubOAuthToolDescriptor("github_graphql")).toBeNull();
    expect(getGitHubOAuthToolDescriptor("github_delete_repository")).toBeNull();
  });

  it("returns fresh schemas/classification so caller mutation cannot weaken the whitelist", () => {
    const entry = getGitHubOAuthToolDescriptor("github_update_issue")!;
    entry.risk = "read";
    entry.inputSchema.additionalProperties = true;
    const next = getGitHubOAuthToolDescriptor(entry.name)!;
    expect(next.risk).toBe("write");
    expect(next.inputSchema.additionalProperties).toBe(false);
  });
});

describe("bounded GitHub read requests", () => {
  it.each([
    ["github_get_account", {}, "https://api.github.com/user"],
    ["github_list_repositories", { page: 2, first: 10 }, "https://api.github.com/user/repos?per_page=10&page=2&sort=full_name&affiliation=owner,collaborator,organization_member"],
    ["github_list_repository_issues", { owner: "test-operator", repo: "synthetic-repo", state: "open", first: 3, page: 2 }, "https://api.github.com/repos/test-operator/synthetic-repo/issues?state=open&per_page=3&page=2"],
  ] as const)("builds fixed REST %s without write requests", async (name, args, url) => {
    const io = harness(() => Response.json(name === "github_get_account" ? user : []));
    await execute(name, args, io.fetch);
    expect(io.calls[0].url).toBe(url);
    expect(io.calls[0].init.method).toBe("GET");
    expect(io.calls[0].init.body).toBeUndefined();
  });

  it.each(["user", "organization"])("uses the exact %s Projects query with typed variables", async (ownerType) => {
    const io = harness(() => Response.json({ data: { [ownerType]: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    await execute("github_list_projects", { owner: "test-operator", ownerType, first: 20, after: "cursor_synthetic" }, io.fetch);
    const request = body(io.calls[0]);
    expect(io.calls[0].url).toBe("https://api.github.com/graphql");
    expect(request.query).toContain(`${ownerType}(login: $owner)`);
    expect(request.query).not.toContain("mutation");
    expect(request.variables).toEqual({ owner: "test-operator", first: 20, after: "cursor_synthetic" });
    expect(io.calls).toHaveLength(1);
  });

  it("reads one file with an encoded ref and verifies exact path/SHA readback", async () => {
    const payload = { type: "file", path: "docs/example.md", sha: "a".repeat(40), encoding: "base64", content: "dGVzdA==\n" };
    const io = harness(() => Response.json(payload));
    expect(await execute("github_get_repository_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md", ref: "topic/synthetic" }, io.fetch)).toEqual(payload);
    expect(io.calls[0].url).toBe("https://api.github.com/repos/test-operator/synthetic-repo/contents/docs/example.md?ref=topic%2Fsynthetic");
    expect(io.calls[0].init.method).toBe("GET");
    expect(io.calls).toHaveLength(1);
  });

  it("permits reading workflow files without enabling workflow writes", async () => {
    const path = ".github/workflows/read-only.yml";
    const io = harness(() => Response.json({ type: "file", path, sha: "a".repeat(40), encoding: "base64", content: "dGVzdA==" }));
    await execute("github_get_repository_file", { owner: "test-operator", repo: "synthetic-repo", path }, io.fetch);
    expect(io.calls[0].init.method).toBe("GET");
  });

  it("preserves project/item/field partial-read indicators without importing or waking agents", async () => {
    const payload = { data: { node: { id: "PVT_synthetic", items: { nodes: [{ id: "PVTI_redacted", type: "REDACTED", content: null }],
      pageInfo: { hasNextPage: true, endCursor: "next_cursor" } }, fields: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "field_cursor" } } } } };
    const io = harness(() => Response.json(payload));
    expect(await execute("github_get_project_items", { projectId: "PVT_synthetic" }, io.fetch)).toEqual(payload);
    const request = body(io.calls[0]);
    expect(request.query).toContain("isArchived");
    expect(request.query).toContain("... on DraftIssue");
    expect(request.query).toContain("hasNextPage endCursor");
    expect(request.query).not.toContain("mutation");
    expect(io.calls).toHaveLength(1);
  });
});

describe("bounded GitHub write requests, not automatic dispatch", () => {
  const writes = [
    ["github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md", branch: "topic/synthetic",
      message: "Synthetic update", content: "dGVzdA==", sha: "a".repeat(40) }, "PUT", "https://api.github.com/repos/test-operator/synthetic-repo/contents/docs/example.md"],
    ["github_create_issue", { owner: "test-operator", repo: "synthetic-repo", title: "Synthetic issue", body: "Synthetic body" }, "POST", "https://api.github.com/repos/test-operator/synthetic-repo/issues"],
    ["github_update_issue", { owner: "test-operator", repo: "synthetic-repo", issueNumber: 12, state: "closed" }, "PATCH", "https://api.github.com/repos/test-operator/synthetic-repo/issues/12"],
    ["github_update_project", { projectId: "PVT_synthetic", title: "Synthetic title" }, "POST", "https://api.github.com/graphql"],
    ["github_add_project_item", { projectId: "PVT_synthetic", contentId: "ISSUE_synthetic" }, "POST", "https://api.github.com/graphql"],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVTSSF_synthetic", value: { singleSelectOptionId: "option_synthetic" } }, "POST", "https://api.github.com/graphql"],
  ] as const;
  it.each(writes)("builds only the fixed reviewed operation %s", async (name, args, method, url) => {
    const results: Record<string, unknown> = {
      github_create_or_update_file: fileWriteResponse(),
      github_create_issue: { id: 1, number: 13, title: "Synthetic issue", body: "Synthetic body" },
      github_update_issue: { id: 1, number: 12, title: "Synthetic issue", state: "closed" },
      github_update_project: { data: { updateProjectV2: { projectV2: { id: "PVT_synthetic", title: "Synthetic title" } } } },
      github_add_project_item: { data: { addProjectV2ItemById: { item: projectItem() } } },
      github_update_project_item_field: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_synthetic", project: { id: "PVT_synthetic" },
        fieldValues: { nodes: [{ optionId: "option_synthetic", field: { id: "PVTSSF_synthetic" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
    };
    const io = harness(() => Response.json(results[name]));
    await execute(name, args, io.fetch);
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0].url).toBe(url);
    expect(io.calls[0].init.method).toBe(method);
    const request = body(io.calls[0]);
    if (url.endsWith("/graphql")) {
      expect(request.query).toMatch(/^mutation/);
      expect(request.variables.input).toEqual(args);
    } else {
      expect(request).not.toHaveProperty("owner");
      expect(request).not.toHaveProperty("repo");
      expect(request).not.toHaveProperty("path");
    }
  });

  it.each(["text", "number", "date", "singleSelectOptionId", "iterationId"])(
    "allows exactly one supported field-value kind: %s", async (kind) => {
      const values: Record<string, unknown> = { text: "Synthetic", number: 12.5, date: "2026-10-12", singleSelectOptionId: "option_synthetic", iterationId: "iteration_synthetic" };
      const readbackKey = kind === "singleSelectOptionId" ? "optionId" : kind;
      const io = harness(() => Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_synthetic", project: { id: "PVT_synthetic" },
        fieldValues: { nodes: [{ [readbackKey]: values[kind], field: { id: "PVT_field" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
      await execute("github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { [kind]: values[kind] } }, io.fetch);
      expect(body(io.calls[0]).variables.input.value).toEqual({ [kind]: values[kind] });
    },
  );

  it("surfaces unknown dispatched-write outcomes without a hidden retry", async () => {
    let calls = 0;
    const fetch: GitHubGuardedFetch = async () => { calls += 1; throw new Error("synthetic-access unknown transport failure"); };
    try {
      await execute("github_create_issue", { owner: "test-operator", repo: "synthetic-repo", title: "Synthetic" }, fetch);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOAuthTransportError);
      expect((error as GitHubOAuthTransportError).details).toEqual({ code: "github_write_outcome_unknown", dispatched: true, outcomeUnknown: true });
      expect((error as Error).message).not.toContain("synthetic-access");
    }
    expect(calls).toBe(1);
  });

  it("bounds a timed-out write and reports unknown outcome rather than calling again", async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const fetch: GitHubGuardedFetch = async (_url, init) => { calls += 1; signal = init?.signal as AbortSignal; return new Promise(() => undefined); };
    await expect(execute("github_create_issue", { owner: "test-operator", repo: "synthetic-repo", title: "Synthetic" }, fetch, 5))
      .rejects.toThrow("github_write_outcome_unknown");
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("unsafe arguments and response gaps fail closed", () => {
  it.each([
    ["github_graphql", { query: "mutation { deleteProjectV2 }" }],
    ["github_get_account", { url: "https://evil.test" }],
    ["github_list_repositories", { first: 51 }], ["github_list_repositories", { page: 0 }],
    ["github_list_repositories", { first: "20" }],
    ["github_list_projects", { owner: "test-operator", ownerType: "user) { mutation" }],
    ["github_list_repository_issues", { owner: "../evil", repo: "synthetic-repo" }],
    ["github_list_repository_issues", { owner: "test-operator", repo: ".." }],
    ["github_get_project_items", { projectId: "PVT_synthetic", query: "mutation" }],
    ["github_update_project", { projectId: "PVT_synthetic", public: true }],
    ["github_update_project", { projectId: "PVT_synthetic" }],
    ["github_update_issue", { owner: "test-operator", repo: "synthetic-repo", issueNumber: 12 }],
    ["github_create_issue", { owner: "test-operator", repo: "synthetic-repo", title: "Synthetic", assignees: ["someone"] }],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: {} }],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { text: "Synthetic", number: 12 } }],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { number: NaN } }],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { date: "2026-02-30" } }],
  ])("rejects unsafe or unsupported arguments before HTTP dispatch %#", async (name, args) => {
    const io = harness();
    await expect(execute(name as string, args, io.fetch)).rejects.toThrow("github_arguments_invalid");
    expect(io.calls).toHaveLength(0);
  });

  it.each(["../secret", "/absolute", "docs//file", "docs\\file", "docs/./file", "docs/%2e%2e/secret", ".github/workflows/run.yml", ".GITHUB/WORKFLOWS/run.yml", "docs/file\0"])(
    "refuses traversal and workflow paths before dispatch: %s", async (path) => {
      const io = harness();
      await expect(execute("github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path,
        branch: "topic/synthetic", message: "Synthetic", content: "dGVzdA==" }, io.fetch)).rejects.toThrow("github_file_path_invalid");
      expect(io.calls).toHaveLength(0);
    },
  );

  it.each([null, {}, { data: null }, { data: {} }, { data: { user: null } }, { data: { user: { projectsV2: { nodes: [] } } } },
    { data: {}, errors: [{ message: "synthetic-secret provider error" }] }, { data: {}, errors: "malformed" }])(
    "rejects GraphQL partial/failure payloads instead of inventing success %#", async (payload) => {
      const io = harness(() => Response.json(payload));
      await expect(execute("github_list_projects", { owner: "test-operator", ownerType: "user" }, io.fetch)).rejects.toThrow("github_graphql_failed");
      expect(io.calls).toHaveLength(1);
    },
  );

  it("keeps partial mutation responses as unknown outcomes", async () => {
    const io = harness(() => Response.json({ data: { addProjectV2ItemById: null }, errors: [{ message: "Synthetic failure" }] }));
    await expect(execute("github_add_project_item", { projectId: "PVT_synthetic", contentId: "ISSUE_synthetic" }, io.fetch))
      .rejects.toThrow("github_write_outcome_unknown");
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    ["github_update_project", { projectId: "PVT_synthetic", title: "Synthetic" }, { data: {} }],
    ["github_update_project", { projectId: "PVT_synthetic", title: "Synthetic" }, { data: { updateProjectV2: { projectV2: { id: "PVT_wrong" } } } }],
    ["github_update_project", { projectId: "PVT_synthetic", title: "Synthetic" }, { data: { updateProjectV2: { projectV2: { id: "PVT_synthetic", title: "Not saved" } } } }],
    ["github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { text: "Synthetic" } },
      { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_wrong" } } } }],
    ["github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md", branch: "topic/synthetic", message: "Synthetic", content: "dGVzdA==" },
      { content: { path: "docs/wrong.md", sha: "b".repeat(40) }, commit: { sha: "c".repeat(40) } }],
    ["github_update_issue", { owner: "test-operator", repo: "synthetic-repo", issueNumber: 12, state: "closed" }, { id: 1, number: 13, title: "Wrong target" }],
  ])("does not claim write success from missing or mismatched authoritative target readback %#", async (name, args, payload) => {
    const io = harness(() => Response.json(payload));
    await expect(execute(name as string, args, io.fetch)).rejects.toThrow("github_write_outcome_unknown");
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    { nodes: [{ text: "Not saved", field: { id: "PVT_field" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: "partial" } },
    { nodes: [{ text: "Synthetic", field: { id: "PVT_wrong" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [{ text: "Synthetic", field: { id: "PVT_field" } }, { text: "Synthetic", field: { id: "PVT_field" } }], pageInfo: { hasNextPage: false, endCursor: null } },
  ])("holds a field write when exact requested value cannot be independently read back %#", async (fieldValues) => {
    const io = harness(() => Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_synthetic", project: { id: "PVT_synthetic" }, fieldValues } } } }));
    await expect(execute("github_update_project_item_field", { projectId: "PVT_synthetic", itemId: "PVTI_synthetic", fieldId: "PVT_field", value: { text: "Synthetic" } }, io.fetch))
      .rejects.toThrow("github_write_outcome_unknown");
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    null, { id: "PVTI_synthetic" }, projectItem({ project: { id: "PVT_wrong" } }),
    projectItem({ content: { __typename: "Issue", id: "ISSUE_wrong" } }),
    projectItem({ content: null }), projectItem({ type: "REDACTED", content: null }),
    projectItem({ type: "DRAFT_ISSUE", content: { __typename: "DraftIssue", id: "ISSUE_synthetic" } }),
    projectItem({ isArchived: true }), projectItem({ type: "PULL_REQUEST" }),
  ])("holds add-item acknowledgement unless exact active project/content membership is read back %#", async (item) => {
    const io = harness(() => Response.json({ data: { addProjectV2ItemById: { item } } }));
    await expect(execute("github_add_project_item", { projectId: "PVT_synthetic", contentId: "ISSUE_synthetic" }, io.fetch))
      .rejects.toThrow("github_write_outcome_unknown");
    expect(io.calls).toHaveLength(1);
  });

  it("accepts exact pull-request membership without creating tasks or following up with another call", async () => {
    const item = projectItem({ type: "PULL_REQUEST", content: { __typename: "PullRequest", id: "PR_synthetic" } });
    const io = harness(() => Response.json({ data: { addProjectV2ItemById: { item } } }));
    await execute("github_add_project_item", { projectId: "PVT_synthetic", contentId: "PR_synthetic" }, io.fetch);
    const request = body(io.calls[0]);
    expect(request.query).toContain("project { id }");
    expect(request.query).toContain("... on PullRequest { id }");
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    fileWriteResponse(Buffer.from("wrong bytes")),
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, sha: "b".repeat(40) } },
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, size: 5 } },
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, type: "symlink" } },
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, git_url: fileWriteResponse().content.git_url.replace("synthetic-repo", "wrong-repo") } },
    { ...fileWriteResponse(), commit: { ...fileWriteResponse().commit, url: fileWriteResponse().commit.url.replace("synthetic-repo", "wrong-repo") } },
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, html_url: fileWriteResponse().content.html_url.replace("topic/synthetic", "main") } },
    { ...fileWriteResponse(), content: { ...fileWriteResponse().content, html_url: fileWriteResponse().content.html_url.replace("github.com", "github.com.evil.test") } },
  ])("does not accept a plausible file/commit SHA as requested bytes/repository/branch proof %#", async (payload) => {
    const io = harness(() => Response.json(payload));
    await expect(execute("github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md",
      branch: "topic/synthetic", message: "Synthetic", content: "dGVzdA==" }, io.fetch)).rejects.toThrow("github_write_outcome_unknown");
    expect(io.calls).toHaveLength(1);
  });

  it("uses the documented Git blob hash vector, not a hash of Base64 or unframed content", async () => {
    const vector = Buffer.from("what is up, doc?");
    const payload = fileWriteResponse(vector);
    expect(payload.content.sha).toBe("bd9dbf5aae1a3862dd1526723246b20206e5fc37");
    const io = harness(() => Response.json(payload));
    await execute("github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md",
      branch: "topic/synthetic", message: "Synthetic", content: vector.toString("base64") }, io.fetch);
    expect(io.calls).toHaveLength(1);
  });

  it("verifies binary byte length rather than a decoded UTF-8 string", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]);
    const io = harness(() => Response.json(fileWriteResponse(bytes)));
    await execute("github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md",
      branch: "topic/synthetic", message: "Synthetic", content: bytes.toString("base64") }, io.fetch);
    expect(io.calls).toHaveLength(1);
  });

  it("accepts canonical repository casing and URI-encoded branch separators without changing target identity", async () => {
    const payload = fileWriteResponse();
    payload.content.git_url = payload.content.git_url.replace("test-operator/synthetic-repo", "TEST-OPERATOR/Synthetic-Repo");
    payload.commit.url = payload.commit.url.replace("test-operator/synthetic-repo", "TEST-OPERATOR/Synthetic-Repo");
    payload.content.html_url = payload.content.html_url.replace("topic/synthetic", "topic%2Fsynthetic");
    const io = harness(() => Response.json(payload));
    await execute("github_create_or_update_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md",
      branch: "topic/synthetic", message: "Synthetic", content: "dGVzdA==" }, io.fetch);
    expect(io.calls).toHaveLength(1);
  });

  it.each([
    ["github_list_repositories", {}, {}], ["github_list_repository_issues", { owner: "test-operator", repo: "synthetic-repo" }, [{ title: "Missing identity" }]],
    ["github_get_repository_file", { owner: "test-operator", repo: "synthetic-repo", path: "docs/example.md" }, { type: "file", path: "docs/wrong.md", sha: "a".repeat(40), encoding: "base64", content: "dGVzdA==" }],
  ])("does not replace unsupported REST readback with an empty result %#", async (name, args, payload) => {
    const io = harness(() => Response.json(payload));
    await expect(execute(name as string, args, io.fetch)).rejects.toThrow("github_response_invalid");
  });

  it.each([0, 30001, NaN, 1.5])("refuses invalid timeout metadata before any request: %s", async (timeout) => {
    const io = harness();
    await expect(execute("github_get_account", {}, io.fetch, timeout)).rejects.toThrow("github_timeout_invalid");
    expect(io.calls).toHaveLength(0);
  });

  it("rejects duplicate case-insensitive authorization headers before any request", async () => {
    const io = harness();
    await expect(executeGitHubOAuthTool({ toolName: "github_get_account", arguments: {}, headers: { ...headers, authorization: "Bearer other-synthetic" } }, io.fetch))
      .rejects.toThrow("github_oauth_bearer_invalid");
    expect(io.calls).toHaveLength(0);
  });
});
