import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (type: string) =>
    type === "blank_local"
      ? { label: "", description: "" }
      : type === "spaces_local"
        ? { label: "   ", description: "" }
        : type === "missing_local"
          ? { label: undefined, description: "" }
          : { label: "Claude Code", description: "" },
}));

import { adapterMismatchLabel } from "./OnboardingConfigurationReview";

describe("adapterMismatchLabel", () => {
  it("uses the display label when there is one", () => {
    expect(adapterMismatchLabel("claude_local")).toBe("Claude Code");
  });

  it("falls back to the adapter type, never blank or 'undefined'", () => {
    for (const type of ["blank_local", "spaces_local", "missing_local"]) {
      const label = adapterMismatchLabel(type);
      expect(label).toBe(type);
      expect(label).not.toContain("undefined");
      expect(label.trim()).not.toBe("");
    }
  });
});
