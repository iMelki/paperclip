import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("DesignGuide showcase fixtures", () => {
  it("serves the primary output from a real public asset instead of a fake attachment API", () => {
    const source = readFileSync(path.join(here, "DesignGuide.tsx"), "utf8");
    expect(source).toContain('contentPath: "/paperclip-thinking.svg"');
    expect(source).toContain("image/svg+xml");
    expect(source).not.toContain("q3-summary.mp4");
  });
});
