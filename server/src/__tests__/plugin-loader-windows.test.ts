import { describe, expect, it } from "vitest";
import { resolveWindowsPluginLauncher } from "../services/plugin-loader.js";

describe("resolveWindowsPluginLauncher", () => {
  it("uses batch launchers for the package managers supported by Windows", () => {
    expect(resolveWindowsPluginLauncher("npm")).toBe("npm.cmd");
    expect(resolveWindowsPluginLauncher("PNPM")).toBe("PNPM.cmd");
  });

  it("preserves other executable names", () => {
    expect(resolveWindowsPluginLauncher("node")).toBe("node");
  });
});
