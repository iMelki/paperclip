// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingConfigurationReview } from "./OnboardingConfigurationReview";
import type { OnboardingAgentConfigReview } from "../lib/onboarding-agent-config";

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (adapterType: string) => ({
    label: adapterType === "codex_local" ? "Codex" : "Claude Code",
  }),
}));

const matchingConfig: OnboardingAgentConfigReview = {
  persistedAdapterType: "codex_local",
  persistedModel: "gpt-5.4",
  adapterMatches: true,
  modelMatches: true,
  configMatches: true,
  matches: true,
};

describe("OnboardingConfigurationReview", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderReview(overrides: {
    savedConfig?: OnboardingAgentConfigReview | null;
    savedConfigVerified?: boolean;
    savedConfigPending?: boolean;
    savedConfigError?: string | null;
  } = {}) {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <OnboardingConfigurationReview
          savedConfig={overrides.savedConfig ?? matchingConfig}
          savedConfigVerified={overrides.savedConfigVerified ?? true}
          savedConfigPending={overrides.savedConfigPending ?? false}
          savedConfigError={overrides.savedConfigError ?? null}
          environmentRequired={false}
          environmentResult={null}
          environmentLoading={false}
          environmentError={null}
        />,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("announces a failed authoritative readback with destructive treatment", () => {
    renderReview({
      savedConfigVerified: false,
      savedConfigError: "Agent could not be loaded",
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Saved readback failed");
    expect(alert?.textContent).toContain("Agent could not be loaded");
    expect(alert?.className).toContain("border-destructive/40");
    expect(alert?.className).toContain("bg-destructive/10");
  });

  it("announces a saved/draft mismatch with the shared warning status treatment", () => {
    renderReview({
      savedConfig: {
        ...matchingConfig,
        persistedAdapterType: "claude_local",
        adapterMatches: false,
        matches: false,
      },
      savedConfigVerified: false,
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("does not match");
    expect(alert?.className).toContain("status-chip");
    expect(alert?.style.getPropertyValue("--sc")).toBe("var(--status-task-todo)");
    expect(alert?.className).not.toMatch(/amber|green/);
  });

  it("shows the authoritative adapter and model without an alert when verified", () => {
    renderReview();

    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).toContain("Verified");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const badge = [...container.querySelectorAll<HTMLElement>("span")]
      .find((element) => element.textContent?.includes("Verified"));
    expect(badge?.className).toContain("status-chip");
    expect(badge?.style.getPropertyValue("--sc")).toBe("var(--status-task-done)");
    expect(badge?.className).not.toMatch(/amber|green/);
  });
});
