import { expect, test } from "vitest";
import { buildHermesConfig } from "./build-config.js";

test("a three-turn UI job has a 15-minute wall-clock cap", () => {
  const config = buildHermesConfig({
    model: "gpt-5.5",
    maxTurnsPerRun: 3,
    cwd: "",
    command: "",
    extraArgs: "",
    thinkingEffort: "",
    promptTemplate: "",
  } as any);
  expect(config.maxTurnsPerRun).toBe(3);
  expect(config.timeoutSec).toBe(900);
});
