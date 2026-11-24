// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  listGitHubBoardReadConnections: vi.fn(),
  listSavedGitHubBoardReadGrants: vi.fn(),
  changeGitHubBoardReadAccess: vi.fn(),
}));
vi.mock("../../api/externalObjects", () => ({ externalObjectsApi: mockApi }));

import { GitHubIssueProjectAccess } from "./GitHubIssueProjectAccess";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE = "00000000-0000-4000-8000-000000000001";
const OBJECT = "00000000-0000-4000-8000-000000000002";
const GRANT = "00000000-0000-4000-8000-000000000003";

describe("GitHubIssueProjectAccess", () => {
  let container: HTMLDivElement;
  let root: Root;
  const refresh = vi.fn();

  beforeEach(() => {
    Object.values(mockApi).forEach(fn => fn.mockReset());
    refresh.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <GitHubIssueProjectAccess issueId={ISSUE} objectId={OBJECT} refresh={refresh} />
      </QueryClientProvider>);
    });
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(item => item.textContent?.includes(label)) as HTMLButtonElement;
  async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error("No button " + label + " in: " + container.textContent);
    await act(async () => {
      target.click();
      // react-query publishes mutation state on a timer, so let it flush before the next assertion.
      await new Promise(resolve => setTimeout(resolve, 25));
    });
  }

  it("says so when no read access is saved", async () => {
    mockApi.listSavedGitHubBoardReadGrants.mockResolvedValue({ grants: [] });
    await mount();
    await click("Manage saved access");
    expect(mockApi.listSavedGitHubBoardReadGrants).toHaveBeenCalledWith(ISSUE, OBJECT);
    expect(container.textContent).toContain("No saved Project read access.");
  });

  it("revokes a saved grant with the exact grant id and refreshes", async () => {
    mockApi.listSavedGitHubBoardReadGrants.mockResolvedValue({ grants: [{ projectId: "PVT_synthetic", grantId: GRANT }] });
    mockApi.changeGitHubBoardReadAccess.mockResolvedValue({ projectId: "PVT_synthetic" });
    await mount();
    await click("Manage saved access");
    await click("Remove read access");
    expect(mockApi.changeGitHubBoardReadAccess).toHaveBeenCalledWith(ISSUE, OBJECT,
      { op: "revoke", projectId: "PVT_synthetic", expectedGrantId: GRANT });
    expect(refresh).toHaveBeenCalled();
    expect(container.textContent).toContain("Project read access removed.");
  });

  it("asks the operator to reconnect when no verified connection exists", async () => {
    mockApi.listGitHubBoardReadConnections.mockResolvedValue({ connections: [] });
    await mount();
    await click("Add GitHub Project");
    expect(container.textContent).toContain("Reconnect GitHub as the signed-in user to add a Project.");
    expect(container.querySelector("form")).toBeNull();
  });

  it("reports a failed access change without claiming success", async () => {
    mockApi.listSavedGitHubBoardReadGrants.mockResolvedValue({ grants: [{ projectId: "PVT_synthetic", grantId: GRANT }] });
    mockApi.changeGitHubBoardReadAccess.mockRejectedValue(new Error("refused"));
    await mount();
    await click("Manage saved access");
    await click("Remove read access");
    expect(container.textContent).toContain("Project access could not be changed.");
    expect(container.textContent).not.toContain("Project read access removed.");
  });
});
