import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";
import { getConfigSchema } from "./config-schema.js";

describe("Hermes local adapter config schema", () => {
  it("offers every supported provider exactly once with the expected default", () => {
    const provider = getConfigSchema().fields.find((field) => field.key === "provider");
    expect(provider).toMatchObject({ type: "select", default: "auto" });
    expect(provider?.options?.map((option) => option.value)).toEqual([...VALID_PROVIDERS]);
    expect(provider?.options?.find((option) => option.value === "openai-codex")?.label)
      .toBe("OpenAI Codex");
    expect(provider?.options?.find((option) => option.value === "minimax-cn")?.label)
      .toBe("MiniMax China");
  });

  it("exposes bounded-run defaults and all strict-isolation inputs without enabling isolation", () => {
    const fields = new Map(getConfigSchema().fields.map((field) => [field.key, field]));
    expect(fields.size).toBe(getConfigSchema().fields.length);
    expect(fields.get("timeoutSec")).toMatchObject({ type: "number", default: DEFAULT_TIMEOUT_SEC });
    expect(fields.get("graceSec")).toMatchObject({ type: "number", default: DEFAULT_GRACE_SEC });
    expect(fields.get("maxTurnsPerRun")?.type).toBe("number");
    expect(fields.get("strictIsolation")).toMatchObject({ type: "toggle", default: false });
    expect(fields.get("hermesHome")?.type).toBe("text");
    expect(fields.get("hermesProfile")?.type).toBe("text");
    expect(fields.get("persistSession")).toMatchObject({ type: "toggle", default: true });
    expect(fields.get("strictIsolation")?.hint).toContain("not effective-auth");
  });
});
