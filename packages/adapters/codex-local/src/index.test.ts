import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  agentConfigurationDoc,
  isCodexLocalFastModeSupported,
  isCodexLocalKnownModel,
  isCodexLocalManualModel,
  models,
  normalizeCodexModel,
} from "./index.js";

const GPT6_MODEL_IDS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const;

describe("codex local adapter metadata", () => {
  it("keeps approval and sandbox bypass opt-in", () => {
    expect(DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX).toBe(false);
  });

  it("advertises current GPT-5.6 Codex-capable OpenAI models by default", () => {
    const modelIds = models.map((model) => model.id);

    // The list constant is the concrete gpt-5.6-sol slug — Codex ships no metadata for the bare
    // gpt-5.6 alias, so it must not be advertised (it triggers a fallback warning).
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    // Newest model version first, then by capability within a version. The GPT-6 ids lead the
    // list. This order only drives the model dropdown; an agent with an empty model field uses
    // the `model` key of its company's Codex home config.toml.
    expect(modelIds.slice(0, 7)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it.each(GPT6_MODEL_IDS)("lists %s as a known model that supports fast mode", (model) => {
    expect(isCodexLocalKnownModel(model)).toBe(true);
    // A listed id is not a manual id, so it must be in the explicit fast-mode list.
    expect(isCodexLocalManualModel(model)).toBe(false);
    expect(CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS).toContain(model);
    expect(isCodexLocalFastModeSupported(model)).toBe(true);
    expect(isCodexLocalFastModeSupported(` ${model} `)).toBe(true);
    expect(normalizeCodexModel(model)).toBe(model);
  });

  it("keeps the GPT-6 ids listed once each", () => {
    const modelIds = models.map((model) => model.id);
    for (const model of GPT6_MODEL_IDS) {
      expect(modelIds.filter((id) => id === model)).toHaveLength(1);
    }
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it("documents the GPT-6 ids in the fast-mode and reasoning-effort text", () => {
    expect(agentConfigurationDoc).toContain("GPT-6 (astra/sol/luna), GPT-6.1 Sol");
    expect(agentConfigurationDoc).toContain(
      "GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, and GPT-5.6 Sol/Terra also accept max|ultra",
    );
    expect(agentConfigurationDoc).toContain("GPT-6 Luna and GPT-5.6 Luna also accept max");
  });

  it("still passes an unknown manual model id through", () => {
    const manualModel = "gpt-6.2-preview";

    expect(isCodexLocalKnownModel(manualModel)).toBe(false);
    expect(isCodexLocalManualModel(manualModel)).toBe(true);
    expect(isCodexLocalFastModeSupported(manualModel)).toBe(true);
    expect(normalizeCodexModel(manualModel)).toBe(manualModel);
    expect(models.some((model) => model.id === manualModel)).toBe(false);
  });

  it("normalizes the legacy bare gpt-5.6 alias to the concrete gpt-5.6-sol slug", () => {
    expect(normalizeCodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("  gpt-5.6  ")).toBe("gpt-5.6-sol");
    // Concrete slugs and unknown/manual model IDs pass through untouched.
    expect(normalizeCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("future-model")).toBe("future-model");
    expect(normalizeCodexModel("")).toBe("");
    expect(normalizeCodexModel(null)).toBe("");
  });
});
