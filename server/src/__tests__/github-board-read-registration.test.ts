import { describe, expect, it } from "vitest";
import {
  GitHubBoardRegistrationRefused,
  registerGitHubBoardRead,
  revokeGitHubBoardRead,
  type GitHubBoardReadCatalog,
  type GitHubBoardReadRegistration,
  type GitHubBoardRegistrationRequest,
} from "../services/github-board-read-registration.js";

const ZERO = "00000000-0000-4000-8000-000000000000";
const AUTH = "a".repeat(64);
const request: GitHubBoardRegistrationRequest = { companyId: ZERO, paperclipProjectId: ZERO, userId: "user-example",
  connectionId: ZERO, projectId: "PVT_synthetic", projectUrl: "https://github.com/orgs/example/projects/1" };
const authority = { oauthUserId: "user-example", accountId: 1001, login: "example", authorizationRevision: AUTH, connectionId: ZERO };

function fakeHost(over: { authority?: typeof authority | null; probe?: Record<string, unknown> } = {}) {
  const store = { grant: null as GitHubBoardReadRegistration | null, catalog: null as GitHubBoardReadCatalog | null };
  const current = over.authority === undefined ? authority : over.authority;
  const host = {
    currentAuthority: async () => current,
    probeBoard: async () => ({ projectId: request.projectId, projectUrl: request.projectUrl, accountId: 1001, login: "example",
      authorizationRevision: AUTH, ...over.probe }),
    withTransaction: async <T,>(fn: (tx: never) => Promise<T>) => fn({
      currentAuthority: async () => current,
      lockCatalog: async () => undefined,
      readGrant: async () => store.grant,
      readCatalog: async () => store.catalog,
      saveGrant: async (value: GitHubBoardReadRegistration) => { store.grant = value; },
      saveCatalog: async (value: GitHubBoardReadCatalog) => { store.catalog = value; },
    } as never),
  };
  return { host, store };
}

describe("registerGitHubBoardRead", () => {
  it("saves a user-scoped grant and catalog for a verified personal authorization", async () => {
    const { host, store } = fakeHost();
    const result = await registerGitHubBoardRead(request, host);
    expect(result.projectId).toBe(request.projectId);
    expect(store.grant).toMatchObject({ userId: "user-example", authorizationRevision: AUTH, version: 1 });
    expect(store.catalog?.projectIds).toEqual([request.projectId]);
  });

  it("refuses when no verified authorization exists or it belongs to another user", async () => {
    await expect(registerGitHubBoardRead(request, fakeHost({ authority: null }).host)).rejects.toBeInstanceOf(GitHubBoardRegistrationRefused);
    await expect(registerGitHubBoardRead(request, fakeHost({ authority: { ...authority, oauthUserId: "someone-else" } }).host))
      .rejects.toBeInstanceOf(GitHubBoardRegistrationRefused);
  });

  it("refuses a malformed board URL or Project identity before any read", async () => {
    const { host } = fakeHost();
    await expect(registerGitHubBoardRead({ ...request, projectId: "bad id!" }, host)).rejects.toBeInstanceOf(GitHubBoardRegistrationRefused);
    await expect(registerGitHubBoardRead({ ...request, projectUrl: "http://github.com/orgs/example/projects/1" }, host)).rejects.toThrow();
  });

  it("refuses when the probed board differs from the request", async () => {
    const { host, store } = fakeHost({ probe: { projectId: "PVT_other" } });
    await expect(registerGitHubBoardRead(request, host)).rejects.toBeInstanceOf(GitHubBoardRegistrationRefused);
    expect(store.grant).toBeNull();
  });
});

describe("revokeGitHubBoardRead", () => {
  it("removes the grant and its catalog entry when the expected grant id matches", async () => {
    const { host, store } = fakeHost();
    const saved = await registerGitHubBoardRead(request, host);
    const tx = {
      lockCatalog: async () => undefined, assertIssueAccess: async () => undefined,
      readGrant: async () => store.grant, readCatalog: async () => store.catalog,
      removeGrant: async () => { store.grant = null; },
      saveCatalog: async (value: GitHubBoardReadCatalog) => { store.catalog = value; },
    };
    const scope = { companyId: ZERO, paperclipProjectId: ZERO, userId: "user-example", projectId: request.projectId };
    await expect(revokeGitHubBoardRead({ ...scope, expectedGrantId: "11111111-1111-4111-8111-111111111111" }, tx))
      .rejects.toBeInstanceOf(GitHubBoardRegistrationRefused);
    await revokeGitHubBoardRead({ ...scope, expectedGrantId: saved.grantId }, tx);
    expect(store.grant).toBeNull();
    expect(store.catalog?.projectIds).toEqual([]);
  });
});
