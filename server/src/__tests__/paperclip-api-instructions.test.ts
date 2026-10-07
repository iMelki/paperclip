import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(new URL("../../../skills/paperclip/SKILL.md", import.meta.url), "utf8");

describe("Paperclip agent API instructions", () => {
  it("documents a structured unblock action and agent ownership restriction", () => {
    expect(skill.includes('"unblockDescriptor"')).toBe(true);
    expect(skill.includes('"owner": { "agentId":')).toBe(true);
    expect(skill.includes("Agents may only name themselves")).toBe(true);
  });

  it("explains the review path precondition and working status fallback", () => {
    expect(skill.includes("executionPolicy.stages")).toBe(true);
    expect(skill.includes("keep the issue `in_progress`")).toBe(true);
    expect(skill.includes("reviewRequest requires an active review or approval stage")).toBe(true);
  });

  it("explains how to recover from document revision conflicts", () => {
    expect(skill.includes("document.latestRevisionId")).toBe(true);
    expect(skill.includes("details.currentRevisionId")).toBe(true);
    expect(skill.includes("Re-read the document")).toBe(true);
  });
});
