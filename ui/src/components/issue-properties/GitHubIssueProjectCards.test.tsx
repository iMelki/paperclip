// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubMirrorRead } from "@paperclipai/shared/github-issue-project-mirror";
import { GitHubIssueProjectCards } from "./GitHubIssueProjectCards";

const issue = { nodeId: "I_synthetic", url: "https://github.com/example/repo/issues/1", title: "Synthetic issue", state: "OPEN" as const };
const card = {
  projectId: "PVT_synthetic", itemId: "PVTI_1", title: "Synthetic board", url: "https://github.com/orgs/example/projects/1",
  revision: "2026-01-01T00:00:00.000Z", observedAt: Date.parse("2026-01-01T12:00:00.000Z"), authorizationRevision: "a".repeat(64),
  state: "present" as const,
  fields: [{ fieldId: "F_1", valueId: "V_1", name: "Status", kind: "singleSelect" as const, value: "Todo", optionId: "O_1" }],
};

describe("GitHubIssueProjectCards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const render = (read: GitHubMirrorRead) => flushSync(() => root.render(<GitHubIssueProjectCards read={read} />));

  it("shows the issue, the project card and its field values for a fresh read", () => {
    render({ state: "fresh", mirror: { issue, projects: [card] } });
    expect(container.textContent).toContain("Synthetic issue");
    expect(container.textContent).toContain("Synthetic board");
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Todo");
    expect(container.querySelector("a[href='https://github.com/orgs/example/projects/1']")).not.toBeNull();
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("hides project cards and explains a denied read", () => {
    render({ state: "denied", mirror: { issue, projects: [card] } });
    expect(container.textContent).not.toContain("Synthetic board");
    expect(container.textContent).toContain("GitHub Project access was denied.");
  });

  it("still shows the saved cards when the whole read is unavailable, with the notice", () => {
    render({ state: "unavailable", mirror: { issue, projects: [card] } });
    expect(container.textContent).toContain("GitHub Project details are unavailable.");
    expect(container.textContent).toContain("Synthetic board");
    expect(container.textContent).toContain("Todo");
  });

  it("shows each card with its own state in a mixed result", () => {
    const other = { ...card, projectId: "PVT_other", title: "Other board" };
    render({ state: "partial", mirror: { issue, projects: [card, other] },
      boardReadStates: [{ projectId: "PVT_synthetic", state: "unavailable" }, { projectId: "PVT_other", state: "fresh" }] });
    expect(container.textContent).toContain("Synthetic board");
    expect(container.textContent).toContain("Other board");
    expect(container.querySelectorAll("[role='status']").length).toBe(2);
    expect(container.textContent).toContain("GitHub Project details are unavailable.");
  });

  it("does not link a URL that is not a GitHub issue or Project URL", () => {
    render({ state: "fresh", mirror: { issue: { ...issue, url: "https://example.com/x" },
      projects: [{ ...card, url: "javascript:alert(1)" }] } });
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("asks for more access when other Projects need a read grant", () => {
    render({ state: "fresh", accessRequired: true, mirror: { issue, projects: [] } });
    expect(container.textContent).toContain("Additional GitHub Projects require verified read access.");
  });

  it("does not list field values for a removed card", () => {
    render({ state: "fresh", mirror: { issue, projects: [{ ...card, state: "removed" }] } });
    expect(container.textContent).toContain("Removed from project");
    expect(container.textContent).not.toContain("Todo");
  });
});
