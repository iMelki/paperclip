import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package build script", () => {
  it("copies static runtime asset directories into dist", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toContain("node ../scripts/build-filesystem.mjs copy-tree");
    expect(buildScript).toContain("src/onboarding-assets dist/onboarding-assets");
    expect(buildScript).toContain("src/built-ins dist/built-ins");
    expect(buildScript).not.toContain("mkdir -p");
    expect(buildScript).not.toContain("cp -R");
  });
});
