// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueExternalObjectGroup } from "../../hooks/useIssueExternalObjects";

const mockApi = vi.hoisted(() => ({
  refreshIssueObjects: vi.fn(),
  refreshGitHubProjectMirror: vi.fn(),
  listGitHubBoardReadConnections: vi.fn(),
  listSavedGitHubBoardReadGrants: vi.fn(),
  changeGitHubBoardReadAccess: vi.fn(),
}));
vi.mock("../../api/externalObjects", () => ({ externalObjectsApi: mockApi }));

import { ExternalObjectRows } from "./external-object-rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE = "00000000-0000-4000-8000-000000000001";
const OBJECT = "00000000-0000-4000-8000-000000000002";

function group(providerKey: string, objectType: string): IssueExternalObjectGroup {
  return {
    pill: { providerKey, objectType, displayKey: "Synthetic", statusCategory: "open", liveness: "live", iconKey: null, href: null },
    mentionCount: 1,
    sourceLabels: [],
    group: { object: { id: OBJECT, providerKey, objectType, statusTone: "neutral" }, mentions: [], mentionCount: 1 },
  } as unknown as IssueExternalObjectGroup;
}

describe("ExternalObjectRows GitHub Project controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(mockApi).forEach(fn => fn.mockReset());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(groups: IssueExternalObjectGroup[]) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <ExternalObjectRows issueId={ISSUE} externalObjects={groups} />
      </QueryClientProvider>);
    });
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it("offers the Projects control only for a linked GitHub issue", async () => {
    await mount([group("github", "pull_request")]);
    expect(button("Projects")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    await mount([group("github", "issue")]);
    expect(button("Projects")).toBeDefined();
  });

  it("reads the Project mirror for the clicked object and shows the access controls", async () => {
    mockApi.refreshGitHubProjectMirror.mockResolvedValue({
      state: "fresh",
      mirror: { issue: { nodeId: "I_synthetic", url: "https://github.com/example/repo/issues/1", title: "Synthetic issue", state: "OPEN" }, projects: [] },
    });
    await mount([group("github", "issue")]);
    await act(async () => { button("Projects")!.click(); await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(mockApi.refreshGitHubProjectMirror).toHaveBeenCalledWith(ISSUE, OBJECT);
    expect(container.textContent).toContain("Synthetic issue");
    expect(container.textContent).toContain("Manage saved access");
  });

  it("shows a failure message when the mirror read fails", async () => {
    mockApi.refreshGitHubProjectMirror.mockRejectedValue(new Error("refused"));
    await mount([group("github", "issue")]);
    await act(async () => { button("Projects")!.click(); await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(container.textContent).toContain("GitHub Project details could not be read.");
  });
});
