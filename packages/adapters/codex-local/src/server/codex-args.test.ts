import { describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
  CodexAdapterArgumentConflictError,
} from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("rewrites the legacy bare gpt-5.6 alias to gpt-5.6-sol and applies fast mode", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6",
      fastMode: true,
    });

    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.args).toContain("gpt-5.6-sol");
    expect(result.args).not.toContain("gpt-5.6");
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
  });

  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for GPT-5.5", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "future-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "future-codex-model",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides when model is omitted (CLI default)", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for known unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5",
      "-",
    ]);
  });

  it("ignores fast mode for gpt-5.4-mini", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4-mini",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });

  it("renders structured sandbox, approval, network, and config-origin arguments", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
      configProfile: "builder",
    });

    expect(result.args).toEqual([
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "workspace-write",
      "--profile",
      "builder",
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-",
    ]);
    expect(result).toMatchObject({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
      ignoreUserConfig: false,
      configProfile: "builder",
      configurationOrigin: "managed_home_profile",
    });
  });

  it("supports a sterile reproducibility canary without making it the default", () => {
    const result = buildCodexExecArgs({
      ignoreUserConfig: true,
      extraArgs: ["--disable", "apps", "--disable", "plugins"],
    });

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "-",
    ]);
    expect(result.configurationOrigin).toBe("sterile");
  });

  it.each([
    ["model duplicate", { model: "gpt-5.6-sol", extraArgs: ["--model", "gpt-5.5"] }],
    ["sandbox duplicate", { sandboxMode: "read-only", extraArgs: ["-s", "workspace-write"] }],
    ["approval duplicate", { approvalPolicy: "never", extraArgs: ["--ask-for-approval=on-request"] }],
    ["raw config override", { extraArgs: ["-c", "model=\"gpt-5.5\""] }],
    ["resume injection", { extraArgs: ["resume", "session-id"] }],
    ["prompt injection", { extraArgs: ["-"] }],
  ])("rejects conflicting extra args: %s", (_name, config) => {
    expect(() => buildCodexExecArgs(config)).toThrow(CodexAdapterArgumentConflictError);
  });

  it.each([
    { dangerouslyBypassApprovalsAndSandbox: true, sandboxMode: "workspace-write" },
    { dangerouslyBypassApprovalsAndSandbox: true, approvalPolicy: "never" },
    { sandboxMode: "read-only", networkAccess: true },
    { ignoreUserConfig: true, configProfile: "builder" },
  ])("rejects conflicting structured configuration %#", (config) => {
    expect(() => buildCodexExecArgs(config)).toThrow(CodexAdapterArgumentConflictError);
  });
});
