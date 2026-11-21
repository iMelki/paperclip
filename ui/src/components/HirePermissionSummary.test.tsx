// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HirePermissionSummary } from "./HirePermissionSummary";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("HirePermissionSummary", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders default permissions for general engineer role", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HirePermissionSummary
          payload={{
            role: "engineer",
            permissions: {},
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Permissions & trust");
    expect(container.textContent).toContain("Hire agents");
    expect(container.textContent).toContain("Not allowed");
    expect(container.textContent).toContain("Create/import skills");
    expect(container.textContent).toContain("Allowed");
    expect(container.textContent).toContain("Standard");
    expect(container.textContent).not.toContain("Agent creation also grants task-assignment authority.");

    act(() => {
      root.unmount();
    });
  });

  it("renders elevated warning for role or permissions with agent creation", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HirePermissionSummary
          payload={{
            role: "ceo",
            permissions: { canCreateAgents: true },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Agent creation also grants task-assignment authority.");

    act(() => {
      root.unmount();
    });
  });

  it("renders low-trust review preset and containment summary", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HirePermissionSummary
          payload={{
            role: "engineer",
            permissions: {
              authorizationPolicy: {
                trustPreset: "low_trust_review",
                trustBoundary: {
                  mode: "low_trust_review",
                  projectIds: ["proj-12345678"],
                },
              },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Low-trust review");
    expect(container.textContent).toContain("Containment");
    expect(container.textContent).toContain("Project proj-123");

    act(() => {
      root.unmount();
    });
  });

  it("summarizes additional preserved permission or policy fields", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HirePermissionSummary
          payload={{
            role: "engineer",
            permissions: {
              customPermissionFlag: true,
              authorizationPolicy: {
                customPolicyRule: "strict",
              },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("2 additional permission or policy fields preserved");

    act(() => {
      root.unmount();
    });
  });
});
