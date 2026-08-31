import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ResponsibleUserDenialUxLab.tsx"),
  "utf8",
);

describe("ResponsibleUserDenialUxLab landmark shell", () => {
  it("uses a dvh-safe root instead of h-screen", () => {
    expect(source).toContain("min-h-dvh bg-muted/20 p-6");
    expect(source).not.toContain("min-h-screen");
  });
});
