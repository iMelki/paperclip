import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  normalizeCodexModel,
} from "../index.js";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  sandboxMode: CodexSandboxMode | null;
  approvalPolicy: CodexApprovalPolicy | null;
  networkAccess: boolean | null;
  ignoreUserConfig: boolean;
  configProfile: string | null;
  configurationOrigin: "sterile" | "managed_home" | "managed_home_profile";
  bypassApprovalsAndSandbox: boolean;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

export class CodexAdapterArgumentConflictError extends Error {
  readonly code = "codex_adapter_argument_conflict";
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    const normalized = [...new Set(conflicts)].sort();
    super(
      `Codex extraArgs contains Paperclip-managed or conflicting arguments: ${normalized.join(", ")}. ` +
        "Use the structured adapter fields or the curated CODEX_HOME configuration instead.",
    );
    this.name = "CodexAdapterArgumentConflictError";
    this.conflicts = normalized;
  }
}

const MANAGED_CODEX_ARGUMENTS = new Set([
  "-a",
  "--ask-for-approval",
  "-c",
  "--config",
  "-C",
  "--cd",
  "--dangerously-bypass-approvals-and-sandbox",
  "--ephemeral",
  "--ignore-user-config",
  "--json",
  "-m",
  "--model",
  "-o",
  "--output-last-message",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "--search",
  "--skip-git-repo-check",
]);

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readSandboxMode(value: unknown): CodexSandboxMode | null {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : null;
}

function readApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  return value === "untrusted" || value === "on-request" || value === "never"
    ? value
    : null;
}

function managedArgumentName(token: string): string | null {
  if (token === "exec" || token === "resume" || token === "review" || token === "-") {
    return token;
  }
  const name = token.split("=", 1)[0] ?? token;
  if (MANAGED_CODEX_ARGUMENTS.has(name)) return name;
  if (/^-(?:a|c|C|m|o|p|s).+/.test(token)) return token.slice(0, 2);
  return null;
}

function assertNoManagedExtraArgs(extraArgs: string[]): void {
  const conflicts = extraArgs
    .map((token) => managedArgumentName(token))
    .filter((token): token is string => token !== null);
  if (conflicts.length > 0) throw new CodexAdapterArgumentConflictError(conflicts);
}

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const model = normalizeCodexModel(asString(record.model, ""));
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const sandboxMode = readSandboxMode(record.sandboxMode);
  const approvalPolicy = readApprovalPolicy(record.approvalPolicy);
  const networkAccess = readOptionalBoolean(record.networkAccess);
  const ignoreUserConfig = asBoolean(record.ignoreUserConfig, false);
  const configProfile = asString(record.configProfile, "").trim() || null;
  const extraArgs = readExtraArgs(record);
  assertNoManagedExtraArgs(extraArgs);

  const structuredConflicts: string[] = [];
  if (bypass && sandboxMode !== null) structuredConflicts.push("bypass + sandboxMode");
  if (bypass && approvalPolicy !== null) structuredConflicts.push("bypass + approvalPolicy");
  if (networkAccess !== null && sandboxMode !== "workspace-write") {
    structuredConflicts.push("networkAccess requires sandboxMode=workspace-write");
  }
  if (ignoreUserConfig && configProfile !== null) {
    structuredConflicts.push("ignoreUserConfig + configProfile");
  }
  if (structuredConflicts.length > 0) {
    throw new CodexAdapterArgumentConflictError(structuredConflicts);
  }

  const args: string[] = [];
  if (search) args.push("--search");
  if (approvalPolicy) args.push("--ask-for-approval", approvalPolicy);
  if (sandboxMode) args.push("--sandbox", sandboxMode);
  if (configProfile) args.push("--profile", configProfile);
  args.push("exec", "--json");
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (ignoreUserConfig) args.push("--ignore-user-config");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (networkAccess !== null) {
    args.push("-c", `sandbox_workspace_write.network_access=${networkAccess}`);
  }
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    sandboxMode: bypass ? "danger-full-access" : sandboxMode,
    approvalPolicy: bypass ? "never" : approvalPolicy,
    networkAccess,
    ignoreUserConfig,
    configProfile,
    configurationOrigin: ignoreUserConfig
      ? "sterile"
      : configProfile
        ? "managed_home_profile"
        : "managed_home",
    bypassApprovalsAndSandbox: bypass,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}
