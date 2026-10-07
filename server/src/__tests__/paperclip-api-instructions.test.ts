import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(new URL("../../../skills/paperclip/SKILL.md", import.meta.url), "utf8");

describe("Paperclip agent API instructions", () => {
  it("explains how to recover from document revision conflicts", () => {
    expect(skill.includes("document.latestRevisionId")).toBe(true);
    expect(skill.includes("details.currentRevisionId")).toBe(true);
    expect(skill.includes("Re-read the document")).toBe(true);
  });
});
