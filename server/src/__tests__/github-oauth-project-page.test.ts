import { describe, expect, it, vi } from "vitest";
import { checkedGitHubProjectPage, githubProjectPageQuery, parseGitHubProjectBoardUrl,
  readGitHubOAuthProjectPage, validateGitHubProjectPageInput } from "../services/github-oauth-project-page.js";

const page = { ownerType: "user" as const, owner: "example", number: 12, after: null, first: 2 };
const headers = { Authorization: "Bearer synthetic-token" };
function payload(ownerType = "user") {
  return { [ownerType]: { projectV2: { id: "PVT_fixture", title: "Synthetic board",
    url: `https://github.com/${ownerType === "user" ? "users" : "orgs"}/example/projects/12`,
    updatedAt: "2026-10-13T00:00:00Z", items: { totalCount: 0,
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
}
const response = (value: unknown, options: ResponseInit = {}) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" }, ...options,
});

describe("fixed server-owned GitHub Project page reader", () => {
  it.each(["user", "organization"] as const)("uses only the fixed %s read query and unwraps GraphQL data", async ownerType => {
    const fetch = vi.fn(async () => response({ data: payload(ownerType) }));
    const read = await readGitHubOAuthProjectPage({ ...page, ownerType }, headers, fetch);
    expect(read.data).toEqual(payload(ownerType));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe(githubProjectPageQuery(ownerType));
    expect(body.query).not.toContain("mutation");
    expect(body.query).toContain("fieldValues(first:100)");
    expect(body.variables).toEqual({ owner: "example", number: 12, after: null, first: 2 });
  });
  it("advances only a bounded opaque cursor", async () => {
    const input = { ...page, after: "Y3Vyc29yMQ==" };
    const fetch = vi.fn(async () => response({ data: payload() }));
    await readGitHubOAuthProjectPage(input, headers, fetch);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).variables.after)
      .toBe(input.after);
  });
  it.each([
    { ...page, first: 0 }, { ...page, first: 51 }, { ...page, number: 0 }, { ...page, ownerType: "viewer" },
    { ...page, owner: "example/other" }, { ...page, after: "https://evil.test" }, { ...page, query: "mutation{}" },
    { ...page, headers: { Authorization: "Bearer other" } }, { ...page, url: "https://evil.test" },
  ])("refuses malformed or extra page parameters before fetch: %j", async input => {
    const fetch = vi.fn();
    await expect(readGitHubOAuthProjectPage(input, headers, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "http://github.com/users/example/projects/12", "https://github.com:8443/users/example/projects/12",
    "https://user@github.com/users/example/projects/12", "https://github.com.evil.test/users/example/projects/12",
    "https://github.com/users/example/projects/12?x=1", "https://github.com/users/example/projects/12#x",
    "https://github.com/users/example/projects/12/", "https://github.com/users/example/projects/0",
    "https://github.com/users/example/projects/2147483648", " https://github.com/users/example/projects/12",
  ])("refuses noncanonical or malicious board URL: %s", value => {
    expect(() => parseGitHubProjectBoardUrl(value)).toThrow();
  });
  it("parses exact personal and organization board references", () => {
    expect(parseGitHubProjectBoardUrl("https://github.com/users/example/projects/12"))
      .toEqual({ ownerType: "user", owner: "example", number: 12, url: "https://github.com/users/example/projects/12" });
    expect(parseGitHubProjectBoardUrl("https://github.com/orgs/example/projects/12").ownerType).toBe("organization");
    expect(validateGitHubProjectPageInput(page)).toEqual(page);
  });
  it.each([
    { errors: [{ message: "Bearer synthetic-token" }], data: payload() }, { errors: [], data: payload() },
    { data: { user: { projectV2: null } } }, { data: {} }, payload(), null,
  ])("refuses partial, missing and wrapped-shape mismatches without reflecting provider text", async value => {
    const fetch = vi.fn(async () => response(value));
    await expect(readGitHubOAuthProjectPage(page, headers, fetch)).rejects.toThrow(/^github_project_/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 401 }, { status: 403 }, { status: 302, headers: { location: "https://evil.test" } },
    { headers: { "Content-Type": "text/html" } },
    { headers: { "Content-Type": "application/json", "content-length": "1000001" } },
  ])("refuses failed/redirected/oversized/invalid-type responses once", async options => {
    const fetch = vi.fn(async () => response({ data: payload() }, options));
    await expect(readGitHubOAuthProjectPage(page, headers, fetch)).rejects.toThrow(/^github_project_/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not expose credential text from transport failure or retry", async () => {
    const fetch = vi.fn(async () => { throw new Error("synthetic-token"); });
    await expect(readGitHubOAuthProjectPage(page, headers, fetch)).rejects.toThrow("github_project_read_failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a streamed response over the cap and malformed JSON", async () => {
    for (const text of ["{", JSON.stringify({ data: "x".repeat(1_000_001) })]) {
      const fetch = vi.fn(async () => new Response(text, { headers: { "content-type": "application/json" } }));
      await expect(readGitHubOAuthProjectPage(page, headers, fetch)).rejects.toThrow(/^github_project_/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    (board: any) => { board.url = "https://github.com/users/other/projects/12"; },
    (board: any) => { board.id = ""; },
    (board: any) => { board.items.totalCount = -1; },
    (board: any) => { board.items.nodes = [{ id: "PVTI_1", isArchived: false,
      fieldValues: { pageInfo: { hasNextPage: true }, nodes: [] } }]; },
    (board: any) => { board.items.pageInfo = { hasNextPage: true, endCursor: null }; },
    (board: any) => { board.updatedAt = "not-a-date"; },
  ])("refuses incomplete, wrong-board and incomplete-field readback", mutate => {
    const value = payload();
    mutate(value.user.projectV2);
    expect(() => checkedGitHubProjectPage(value, page)).toThrow("github_project_page_incomplete");
  });
  it("refuses a nonadvancing cursor", () => {
    const value = payload();
    Object.assign(value.user.projectV2.items.pageInfo, { hasNextPage: true, endCursor: "same" });
    expect(() => checkedGitHubProjectPage(value, { ...page, after: "same" })).toThrow();
  });
});
