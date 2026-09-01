import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import {
  buildOnboardingAgentUpdatePatch,
  readAdapterModel,
  reviewOnboardingAgentConfig,
  selectOnboardingAdapterModel,
} from "./onboarding-agent-config";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "ceo",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-6" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: { canCreateAgents: false },
    metadata: null,
    ...overrides,
  };
}

describe("onboarding agent configuration", () => {
  it("clears an explicit Claude model when the adapter changes to Codex", () => {
    expect(
      selectOnboardingAdapterModel(
        "claude_local",
        "codex_local",
        "claude-sonnet-4-6",
      ),
    ).toBe("");
  });

  it("selects adapter-owned defaults instead of carrying a previous model", () => {
    expect(
      selectOnboardingAdapterModel("claude_local", "gemini_local", "claude-model"),
    ).not.toBe("");
    expect(
      selectOnboardingAdapterModel("claude_local", "cursor", "claude-model"),
    ).not.toBe("");
    expect(
      selectOnboardingAdapterModel("claude_local", "opencode_local", "claude-model"),
    ).not.toBe("");
    expect(
      selectOnboardingAdapterModel("codex_local", "claude_local", "gpt-model"),
    ).toBe("");
  });

  it("keeps a manual model when the selected adapter card is clicked again", () => {
    expect(
      selectOnboardingAdapterModel(
        "codex_local",
        "codex_local",
        "gpt-5.4",
      ),
    ).toBe("gpt-5.4");
  });

  it("builds an adapter-replacement patch for an existing onboarding agent", () => {
    const patch = buildOnboardingAgentUpdatePatch(
      makeAgent({
        adapterConfig: {
          model: "claude-sonnet-4-6",
          cwd: "C:/existing-work",
          command: "claude-custom",
          args: ["--resume", "session-1"],
          url: "https://existing.example",
          engine: "acp",
          stateDir: "C:/claude-state",
          paperclipSkillSync: { desiredSkillEntries: ["planning"] },
        },
      }),
      "codex_local",
      { model: "gpt-5.4", cwd: "C:/work" },
    );

    expect(patch).toMatchObject({
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.4",
        cwd: "C:/work",
        paperclipSkillSync: { desiredSkillEntries: ["planning"] },
      },
      replaceAdapterConfig: true,
    });
    expect(patch.adapterConfig).not.toHaveProperty("engine");
    expect(patch.adapterConfig).not.toHaveProperty("stateDir");
  });

  it("preserves unexposed same-adapter settings while applying onboarding-owned edits", () => {
    const patch = buildOnboardingAgentUpdatePatch(
      makeAgent({
        adapterConfig: {
          model: "claude-sonnet-4-6",
          cwd: "C:/existing-work",
          command: "claude-custom",
          args: ["--resume", "session-1"],
          url: "https://existing.example",
          engine: "acp",
          stateDir: "C:/claude-state",
          timeoutSec: 91,
          workspaceStrategy: { type: "git_worktree", baseRef: "dev" },
          env: {
            EXISTING_TOKEN: { type: "secret_ref", secretId: "secret-1" },
          },
        },
      }),
      "claude_local",
      {
        model: "claude-haiku-4-5",
        cwd: "C:/work",
        env: { ANTHROPIC_API_KEY: { type: "plain", value: "" } },
      },
      { model: true },
    );

    expect(patch).not.toHaveProperty("adapterType");
    expect(patch.adapterConfig).toMatchObject({
      model: "claude-haiku-4-5",
      cwd: "C:/existing-work",
      command: "claude-custom",
      args: ["--resume", "session-1"],
      url: "https://existing.example",
      engine: "acp",
      stateDir: "C:/claude-state",
      timeoutSec: 91,
      workspaceStrategy: { type: "git_worktree", baseRef: "dev" },
      env: {
        EXISTING_TOKEN: { type: "secret_ref", secretId: "secret-1" },
        ANTHROPIC_API_KEY: { type: "plain", value: "" },
      },
    });
  });

  it("clears only the explicit model when same-adapter default behavior is selected", () => {
    const patch = buildOnboardingAgentUpdatePatch(
      makeAgent({
        adapterConfig: {
          model: "claude-sonnet-4-6",
          engine: "acp",
          configProfile: "operator-owned",
        },
      }),
      "claude_local",
      {},
      { model: true },
    );

    expect(patch.adapterConfig).not.toHaveProperty("model");
    expect(patch.adapterConfig).toMatchObject({
      engine: "acp",
      configProfile: "operator-owned",
    });
  });

  it("updates or clears a URL only after an explicit URL edit", () => {
    const agent = makeAgent({
      adapterType: "http",
      adapterConfig: {
        url: "https://existing.example/hook",
        command: "operator-owned",
      },
    });
    const updated = buildOnboardingAgentUpdatePatch(
      agent,
      "http",
      { url: "https://next.example/hook" },
      { url: true },
    );
    const cleared = buildOnboardingAgentUpdatePatch(
      agent,
      "http",
      {},
      { url: true },
    );
    expect(updated.adapterConfig).toMatchObject({
      url: "https://next.example/hook",
      command: "operator-owned",
    });
    expect(cleared.adapterConfig).not.toHaveProperty("url");
    expect(cleared.adapterConfig).toMatchObject({ command: "operator-owned" });
  });

  it("verifies the adapter and model from the persisted agent readback", () => {
    const review = reviewOnboardingAgentConfig(
      makeAgent({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      }),
      "codex_local",
      { model: "gpt-5.4" },
    );

    expect(review).toEqual({
      persistedAdapterType: "codex_local",
      persistedModel: "gpt-5.4",
      adapterMatches: true,
      modelMatches: true,
      configMatches: true,
      matches: true,
    });
  });

  it("requires the authoritative readback to preserve the complete expected config", () => {
    const intended = {
      model: "claude-sonnet-4-6",
      engine: "acp",
      stateDir: "C:/claude-state",
    };
    const preserved = reviewOnboardingAgentConfig(
      makeAgent({ adapterConfig: intended }),
      "claude_local",
      intended,
      true,
    );
    const lostSentinel = reviewOnboardingAgentConfig(
      makeAgent({ adapterConfig: { model: "claude-sonnet-4-6" } }),
      "claude_local",
      intended,
      true,
    );

    expect(preserved).toMatchObject({ configMatches: true, matches: true });
    expect(lostSentinel).toMatchObject({
      adapterMatches: true,
      modelMatches: true,
      configMatches: false,
      matches: false,
    });
  });

  it("reports adapter and model mismatches independently", () => {
    const adapterMismatch = reviewOnboardingAgentConfig(
      makeAgent({ adapterConfig: { model: "gpt-5.4" } }),
      "codex_local",
      { model: "gpt-5.4" },
    );
    const modelMismatch = reviewOnboardingAgentConfig(
      makeAgent(),
      "claude_local",
      { model: "claude-haiku-4-5" },
    );

    expect(adapterMismatch.adapterMatches).toBe(false);
    expect(adapterMismatch.modelMatches).toBe(true);
    expect(adapterMismatch.matches).toBe(false);
    expect(modelMismatch.adapterMatches).toBe(true);
    expect(modelMismatch.modelMatches).toBe(false);
    expect(modelMismatch.matches).toBe(false);
  });

  it("treats blank and absent models as the same adapter-default value", () => {
    expect(readAdapterModel({ model: "   " })).toBeNull();
    expect(
      reviewOnboardingAgentConfig(
        makeAgent({ adapterConfig: {} }),
        "claude_local",
        { model: "" },
      ).matches,
    ).toBe(true);
  });
});
