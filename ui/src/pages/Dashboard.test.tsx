import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Dashboard.tsx"), "utf8");

describe("Dashboard narrow reflow", () => {
  it("collapses charts to one column before sm", () => {
    expect(source).toContain("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4");
    expect(source).not.toContain("grid grid-cols-2 lg:grid-cols-4");
  });
});
