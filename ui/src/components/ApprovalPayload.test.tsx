// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("shows effective hire permissions and elevated-authority consequences", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Delegated Engineer",
            role: "engineer",
            permissions: {
              canCreateAgents: true,
              canCreateSkills: false,
              trustPreset: "standard",
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Permissions & trust");
    expect(container.textContent).toContain("Hire agentsAllowed");
    expect(container.textContent).toContain("Create/import skillsNot allowed");
    expect(container.textContent).toContain("TrustStandard");
    expect(container.textContent).toContain("Agent creation also grants task-assignment authority.");

    act(() => {
      root.unmount();
    });
  });

  it("shows role defaults, restrictive overrides, and low-trust containment", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Restricted CEO",
            role: "ceo",
            permissions: {
              canCreateAgents: false,
              trustPreset: "low_trust_review",
              authorizationPolicy: {
                trustBoundary: {
                  mode: "low_trust_review",
                  projectIds: ["00000000-0000-4000-8000-000000000123"],
                },
              },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Hire agentsNot allowed");
    expect(container.textContent).toContain("Create/import skillsAllowed");
    expect(container.textContent).toContain("TrustLow-trust review");
    expect(container.textContent).toContain("ContainmentProject 00000000");
    expect(container.textContent).toContain("Additional policyLow-trust policy included");
    expect(container.querySelector('section[aria-label="Permissions and trust"] dl')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("states when low-trust containment is not configured", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Review Agent",
            role: "engineer",
            permissions: { trustPreset: "low_trust_review" },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Hire agentsNot allowed");
    expect(container.textContent).toContain("ContainmentNot configured");

    act(() => {
      root.unmount();
    });
  });

  it("summarizes nested low-trust and unknown fields without exposing their names", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Contained Agent",
            role: "engineer",
            permissions: {
              privateExtensionSecretName: true,
              authorizationPolicy: {
                trustBoundary: { mode: "low_trust_review" },
                privatePolicyField: true,
              },
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("TrustLow-trust review");
    expect(container.textContent).toContain("2 additional permission or policy fields preserved");
    expect(container.textContent).not.toContain("privateExtensionSecretName");
    expect(container.textContent).not.toContain("privatePolicyField");

    act(() => {
      root.unmount();
    });
  });
});
