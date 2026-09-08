import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "CrossIssueCollaborationUxLab.tsx"),
  "utf8",
);

describe("CrossIssueCollaborationUxLab narrow reflow", () => {
  it("keeps lab frames from overflowing a 390 viewport", () => {
    expect(source).toContain("min-h-dvh min-w-0 bg-muted/20 p-6");
    expect(source).toContain("min-w-0 space-y-2");
    expect(source).toContain("flex min-w-0 flex-wrap items-center gap-1.5 px-1");
  });
});
