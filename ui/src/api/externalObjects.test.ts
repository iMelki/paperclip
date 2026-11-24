import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("./client", () => ({ api: mockApi }));

import { externalObjectsApi } from "./externalObjects";

const ISSUE = "00000000-0000-4000-8000-000000000001";
const OBJECT = "00000000-0000-4000-8000-000000000002";

describe("externalObjectsApi GitHub Project mirror calls", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({});
  });

  it("posts the linked object id to the mirror route", async () => {
    await externalObjectsApi.refreshGitHubProjectMirror(ISSUE, OBJECT);
    expect(mockApi.post).toHaveBeenCalledWith(`/issues/${ISSUE}/github-project-mirror`, { objectId: OBJECT });
  });

  it("lists connections and saved grants through the access route", async () => {
    await externalObjectsApi.listGitHubBoardReadConnections(ISSUE, OBJECT);
    await externalObjectsApi.listSavedGitHubBoardReadGrants(ISSUE, OBJECT);
    expect(mockApi.post).toHaveBeenNthCalledWith(1, `/issues/${ISSUE}/github-project-access`,
      { objectId: OBJECT, action: { op: "list" } });
    expect(mockApi.post).toHaveBeenNthCalledWith(2, `/issues/${ISSUE}/github-project-access`,
      { objectId: OBJECT, action: { op: "saved" } });
  });

  it("sends register and revoke actions unchanged", async () => {
    const register = { op: "register" as const, connectionId: OBJECT, boardUrl: "https://github.com/orgs/example/projects/1" };
    const revoke = { op: "revoke" as const, projectId: "PVT_synthetic", expectedGrantId: OBJECT };
    await externalObjectsApi.changeGitHubBoardReadAccess(ISSUE, OBJECT, register);
    await externalObjectsApi.changeGitHubBoardReadAccess(ISSUE, OBJECT, revoke);
    expect(mockApi.post).toHaveBeenNthCalledWith(1, `/issues/${ISSUE}/github-project-access`, { objectId: OBJECT, action: register });
    expect(mockApi.post).toHaveBeenNthCalledWith(2, `/issues/${ISSUE}/github-project-access`, { objectId: OBJECT, action: revoke });
  });
});
