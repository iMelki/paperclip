import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCodexLocalConfig", () => {
  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildCodexLocalConfig(makeValues({ codexEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });

  it("persists structured Codex execution controls without the bypass flag", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        dangerouslyBypassSandbox: false,
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "never",
        codexNetworkAccess: false,
        codexIgnoreUserConfig: false,
        codexConfigProfile: "builder",
      }),
    );

    expect(config).toMatchObject({
      dangerouslyBypassApprovalsAndSandbox: false,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccess: false,
      ignoreUserConfig: false,
      configProfile: "builder",
    });
  });

  it("keeps ignoreUserConfig an explicit canary-only field", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        dangerouslyBypassSandbox: false,
        codexIgnoreUserConfig: true,
        codexConfigProfile: "",
      }),
    );

    expect(config).toMatchObject({
      dangerouslyBypassApprovalsAndSandbox: false,
      ignoreUserConfig: true,
    });
    expect(config).not.toHaveProperty("configProfile");
  });
});
