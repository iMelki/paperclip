import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "..");

function readUi(relativePath: string) {
  return readFileSync(join(uiSrc, relativePath), "utf8");
}

describe("narrow viewport reflow", () => {
  it("stacks the members table below md so --gtc-24 cannot overflow 390", () => {
    const source = readUi("pages/CompanyAccess.tsx");
    expect(source).toContain("hidden gap-3 border-b border-border px-4 py-3");
    expect(source).toContain("md:grid md:grid-cols-(--gtc-24)");
    expect(source).toContain("grid grid-cols-1 gap-3");
    expect(source).toContain("md:grid-cols-(--gtc-24) md:items-center");
    expect(source).not.toMatch(/className="grid grid-cols-\(--gtc-24\)/);
  });

  it("collapses dashboard charts to one column before sm", () => {
    const source = readUi("pages/Dashboard.tsx");
    expect(source).toContain("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4");
    expect(source).not.toContain("grid grid-cols-2 lg:grid-cols-4");
  });

  it("clips horizontal overflow on mobile main instead of overflowing visibly", () => {
    const source = readUi("components/Layout.tsx");
    expect(source).toContain("min-w-0 overflow-x-clip pb-(--sz-calc-14)");
    expect(source).not.toContain("overflow-visible pb-(--sz-calc-14)");
  });

  it("zeros Tailwind transition timings under prefers-reduced-motion", () => {
    const source = readUi("index.css");
    expect(source).toContain("transition-duration: 0.01ms !important");
    expect(source).toContain("transition-delay: 0ms !important");
    expect(source).toContain("animation-* alone");
  });

  it("keeps unprefixed onboarding inside the access gate while preserving its landmark", () => {
    const source = readUi("App.tsx");
    const standaloneOnboarding = source.indexOf(
      '<Route path="onboarding" element={<StandaloneMain><OnboardingRoutePage /></StandaloneMain>} />',
    );
    const gate = source.indexOf("<Route element={<CloudAccessGate />}>");
    const gateEnd = source.indexOf("\n          </Route>", gate);
    expect(standaloneOnboarding).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(standaloneOnboarding).toBeGreaterThan(gate);
    expect(standaloneOnboarding).toBeLessThan(gateEnd);
  });

  it("gives every standalone UX-lab route a main landmark", () => {
    const source = readUi("App.tsx");

    expect(source).toContain(
      '<Route path="ux-lab/issue-chat" element={<StandaloneMain><IssueChatUxLab /></StandaloneMain>} />',
    );
    expect(source).toContain(
      '<Route path="ux-lab/loading-chrome" element={<StandaloneMain><LoadingChromeUxLab /></StandaloneMain>} />',
    );
  });
});
