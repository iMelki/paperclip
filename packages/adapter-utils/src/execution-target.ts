import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SshRemoteExecutionSpec } from "./ssh.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeAsset,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import {
  buildRemoteExecutionSessionIdentity,
  prepareRemoteManagedRuntime,
  remoteExecutionSessionMatches,
} from "./remote-managed-runtime.js";
import {
  createPrivateExecutableAssetDirectory,
  type PrivateExecutableAssetDirectory,
} from "./private-executable-asset.js";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
  syncRemoteTextFileWithHashSkip,
} from "./sandbox-callback-bridge.js";
import {
  createSandboxRunLogTailFactory,
  type SandboxRunLogTailFactory,
} from "./sandbox-run-log-stream.js";
import { createSshCommandManagedRuntimeRunner, parseSshRemoteExecutionSpec, runSshCommand, shellQuote } from "./ssh.js";
import {
  ensureCommandResolvable,
  resolveCommandForLogs,
  runChildProcess,
  type RunProcessResult,
  type TerminalResultCleanupOptions,
} from "./server-utils.js";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import { shellQuotePath } from "./shell-path.js";
import type { RuntimeProgressSink, RuntimeStatusSink } from "./runtime-progress.js";
import type { LocalProcessSandboxOptions } from "./local-process-sandbox.js";

export type { RuntimeProgressSink } from "./runtime-progress.js";

export type AdapterWorkspaceRealizationMode = "copy" | "in_place";

export interface AdapterWorkspacePathAlias {
  path: string;
  target: string;
}

export interface AdapterWorkspaceRealization {
  mode: AdapterWorkspaceRealizationMode;
  authoritativeRoot: string;
  pathAliases: AdapterWorkspacePathAlias[];
  outboundRestorePaths: string[];
}

interface AdapterExecutionTargetWorkspaceMetadata {
  workspaceRealization?: AdapterWorkspaceRealization | null;
}

export interface AdapterLocalExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "local";
  environmentId?: string | null;
  leaseId?: string | null;
}

export interface AdapterSshExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "remote";
  transport: "ssh";
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  spec: SshRemoteExecutionSpec;
}

export interface AdapterSandboxExecutionTarget extends AdapterExecutionTargetWorkspaceMetadata {
  kind: "remote";
  transport: "sandbox";
  providerKey?: string | null;
  shellCommand?: "bash" | "sh" | null;
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
  runner?: CommandManagedRuntimeRunner;
  /**
   * Sandbox-backed adapter runs stream the agent CLI's stdout/stderr
   * incrementally via a log-tail loop beside the callback bridge instead of
   * waiting for the batched provider result. Streaming is ON by default;
   * set to `false` to explicitly opt out back to batch-at-end delivery.
   */
  streamRunLogs?: boolean | null;
}

export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterSshExecutionTarget
  | AdapterSandboxExecutionTarget;

export type AdapterRemoteExecutionSpec = SshRemoteExecutionSpec;

// The adapter-facing managed-runtime asset type. Aliased to the sandbox/command
// asset descriptor so the per-asset lifecycle contributions (`provision` /
// `restore`) declared on the sandbox core are load-bearing all the way from the
// adapter call site through to the sandbox runtime. The SSH transport consumes
// the subset of fields it understands and ignores the rest.
export type AdapterManagedRuntimeAsset = CommandManagedRuntimeAsset;

export interface PreparedAdapterExecutionTargetRuntime {
  target: AdapterExecutionTarget;
  workspaceRemoteDir: string | null;
  runtimeRootDir: string | null;
  assetDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

export interface AdapterExecutionTargetProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onRuntimeProgress?: RuntimeStatusSink;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  terminalResultCleanup?: TerminalResultCleanupOptions;
  /**
   * Sandbox-only: factory from the Paperclip bridge handle that streams the
   * CLI's stdout/stderr during the run. When provided, the batched provider
   * onLog is suppressed and incremental chunks flow through `onLog` instead.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  localProcessSandbox?: LocalProcessSandboxOptions | null;
}

export interface AdapterExecutionTargetShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface AdapterExecutionTargetPaperclipBridgeHandle {
  env: Record<string, string>;
  /**
   * Present when the sandbox target opted into run-log streaming
   * (`streamRunLogs`). Create one handle per CLI attempt and pass it to
   * `runAdapterExecutionTargetProcess` via `options.runLogTail`.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  stop(): Promise<void>;
}

export interface AdapterExecutionTargetProcessSessionBridgeHandle {
  agentCommand: string;
  launchIdentity: AdapterExecutionTargetProcessSessionLaunchIdentity;
  reconcileTerminal(): Promise<boolean>;
  treeCustody: "unverified";
  stop(): Promise<void>;
}

export const ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS = "ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS";
export const ACP_PROCESS_SESSION_LAUNCH_EVENT = "acp.process_session.launch";

export interface AdapterExecutionTargetProcessSessionLaunchIdentity {
  launchId: string;
  sessionId: string;
  runId: string;
  adapterKey: string;
  transport: "sandbox";
  providerKey: string | null;
  environmentId: string | null;
  leaseId: string | null;
  remoteCwd: string;
  sessionDir: string;
  eventsDir: string;
  launchIdentityPath: string;
  launcherPidPath: string;
  wrapperPidPath: string;
  launchAcceptedPath: string;
  terminalReceiptPath: string;
  childClosedPath: string;
  wrapperDonePath: string;
}

export interface AdapterExecutionTargetProcessSessionLaunchState {
  status: "launching" | "accepted" | "not_started";
  acceptedStart: "unknown" | "accepted";
  retryable: boolean;
  launchIdentity: AdapterExecutionTargetProcessSessionLaunchIdentity;
}

/**
 * The remote launch transport lost the result after launch may have started.
 * Callers must not retry this operation until an operator has reconciled the
 * durable session evidence named by `sessionDir`.
 */
export class AdapterExecutionTargetProcessSessionLaunchAmbiguousError extends Error {
  readonly code = ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS;
  readonly retryable = false;
  readonly needsHuman = true;
  readonly acceptedStart: "unknown" | "accepted";
  readonly reconcileTerminal: (() => Promise<boolean>) | null;
  readonly cleanupAcceptedHostResources: (() => Promise<void>) | null;

  constructor(
    readonly launchIdentity: AdapterExecutionTargetProcessSessionLaunchIdentity,
    detail: string,
    options: {
      cause?: unknown;
      acceptedStart?: "unknown" | "accepted";
      reconcileTerminal?: () => Promise<boolean>;
      cleanupAcceptedHostResources?: () => Promise<void>;
    } = {},
  ) {
    super(
      `Sandbox ACP process session launch ${launchIdentity.launchId} has an ambiguous accepted-start state; ` +
        `do not retry until the durable launch evidence under ${launchIdentity.sessionDir} is reconciled. ${detail}`,
      options,
    );
    this.name = "AdapterExecutionTargetProcessSessionLaunchAmbiguousError";
    this.acceptedStart = options.acceptedStart ?? "unknown";
    this.reconcileTerminal = options.reconcileTerminal ?? null;
    this.cleanupAcceptedHostResources = options.cleanupAcceptedHostResources ?? null;
  }
}

export function isAdapterExecutionTargetProcessSessionLaunchAmbiguousError(
  error: unknown,
): error is AdapterExecutionTargetProcessSessionLaunchAmbiguousError {
  if (error instanceof AdapterExecutionTargetProcessSessionLaunchAmbiguousError) return true;
  const candidate = error as {
    code?: unknown;
    retryable?: unknown;
    needsHuman?: unknown;
    acceptedStart?: unknown;
    launchIdentity?: unknown;
  } | null;
  return Boolean(
    candidate &&
      candidate.code === ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS &&
      candidate.retryable === false &&
      candidate.needsHuman === true &&
      (candidate.acceptedStart === "unknown" || candidate.acceptedStart === "accepted") &&
      candidate.launchIdentity &&
      typeof candidate.launchIdentity === "object",
  );
}

export { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

// 4-hour wall-clock backstop for sandbox-backed adapter runs. This is a
// last-resort kill switch, not the primary hang detector: genuinely hung runs
// are caught much earlier by the adapters' output-inactivity monitors (e.g.
// codex-local's 7-minute monitor). The value intentionally matches the
// recovery watchdog's ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS (4h) in
// server/src/services/recovery/service.ts so healthy long runs are never
// killed by the adapter before the watchdog would even consider them stuck.
export const DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC = 14_400;

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringMeta(parsed: Record<string, unknown>, key: string): string | null {
  return readString(parsed[key]);
}

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

function resolveDefaultPaperclipApiUrl(): string {
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  // 3100 matches the default Paperclip dev server port when the runtime does not provide one.
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  return `http://${runtimeHost}:${runtimePort}`;
}

function isBridgeDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PAPERCLIP_BRIDGE_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isAdapterExecutionTargetInstance(value: unknown): value is AdapterExecutionTarget {
  const parsed = parseObject(value);
  if (parsed.kind === "local") return true;
  if (parsed.kind !== "remote") return false;
  if (parsed.transport === "ssh") return parseSshRemoteExecutionSpec(parseObject(parsed.spec)) !== null;
  if (parsed.transport !== "sandbox") return false;
  return readStringMeta(parsed, "remoteCwd") !== null;
}

export function adapterExecutionTargetToRemoteSpec(
  target: AdapterExecutionTarget | null | undefined,
): AdapterRemoteExecutionSpec | null {
  return target?.kind === "remote" && target.transport === "ssh" ? target.spec : null;
}

export function adapterExecutionTargetIsRemote(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function adapterExecutionTargetUsesManagedHome(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox";
}

export function adapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  localCwd: string,
): string {
  return target?.kind === "remote" ? target.remoteCwd : localCwd;
}

export function overrideAdapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  remoteCwd: string | null | undefined,
): AdapterExecutionTarget | null | undefined {
  const nextRemoteCwd = remoteCwd?.trim();
  if (!target || target.kind !== "remote" || !nextRemoteCwd) {
    return target;
  }
  if (target.remoteCwd === nextRemoteCwd) {
    return target;
  }
  if (target.transport === "ssh") {
    return {
      ...target,
      remoteCwd: nextRemoteCwd,
      spec: {
        ...target.spec,
        remoteCwd: nextRemoteCwd,
      },
    };
  }
  return {
    ...target,
    remoteCwd: nextRemoteCwd,
  };
}

export function resolveAdapterExecutionTargetCwd(
  target: AdapterExecutionTarget | null | undefined,
  configuredCwd: string | null | undefined,
  localFallbackCwd: string,
): string {
  if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) {
    return configuredCwd;
  }
  return adapterExecutionTargetRemoteCwd(target, localFallbackCwd);
}

export function adapterExecutionTargetUsesPaperclipBridge(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function describeAdapterExecutionTarget(
  target: AdapterExecutionTarget | null | undefined,
): string {
  if (!target || target.kind === "local") return "local environment";
  if (target.transport === "ssh") {
    return `SSH environment ${target.spec.username}@${target.spec.host}:${target.spec.port}`;
  }
  return `sandbox environment${target.providerKey ? ` (${target.providerKey})` : ""}`;
}

export type AdapterExecutionTargetTimeoutSource =
  | "configured"
  | "sandbox_default"
  | "unlimited";

export interface AdapterExecutionTargetTimeoutResolution {
  /** Resolved wall-clock timeout in seconds; 0 means no adapter timeout. */
  timeoutSec: number;
  /** Which knob produced the resolved value, for logs and error messages. */
  source: AdapterExecutionTargetTimeoutSource;
}

export function resolveAdapterExecutionTargetTimeout(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): AdapterExecutionTargetTimeoutResolution {
  if (typeof configuredTimeoutSec === "number" && Number.isFinite(configuredTimeoutSec)) {
    // Preserve fractional (sub-second) configured values instead of flooring:
    // adapters historically honored e.g. timeoutSec=0.5, and flooring would
    // silently turn it into "no timeout".
    if (configuredTimeoutSec > 0) {
      return { timeoutSec: configuredTimeoutSec, source: "configured" };
    }
    // A negative timeoutSec is the explicit "no adapter wall-clock timeout"
    // opt-out, honored even on sandbox targets. Zero cannot carry that
    // meaning: the adapter config UI persists the schema default of 0 for
    // untouched fields, so timeoutSec=0 in stored config does not signal
    // operator intent and falls through to target defaults below.
    if (configuredTimeoutSec < 0) {
      return { timeoutSec: 0, source: "configured" };
    }
  }
  // Local and SSH adapters preserve the historical "0 means no adapter
  // timeout" behavior. Sandbox-backed runs execute through provider RPCs
  // that usually apply their own shorter command defaults, so request an
  // explicit longer timeout for full adapter runs when the adapter leaves
  // timeoutSec unset.
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return { timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC, source: "sandbox_default" };
  }
  return { timeoutSec: 0, source: "unlimited" };
}

export function resolveAdapterExecutionTargetTimeoutSec(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): number {
  return resolveAdapterExecutionTargetTimeout(target, configuredTimeoutSec).timeoutSec;
}

function describeAdapterExecutionTimeoutSource(
  source: AdapterExecutionTargetTimeoutSource,
): string {
  switch (source) {
    case "configured":
      return "configured via adapterConfig.timeoutSec";
    case "sandbox_default":
      return "sandbox default";
    case "unlimited":
      return "no adapter wall-clock timeout";
  }
}

/**
 * Self-describing error message for when the adapter wall-clock execution
 * timeout kills a run. Names the timer that fired and the knob that controls
 * it so run failures never surface as a bare "Timed out".
 */
export function formatAdapterExecutionTimeoutErrorMessage(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  return (
    `Run exceeded the adapter execution timeout ` +
    `(timeoutSec=${resolution.timeoutSec}, ${describeAdapterExecutionTimeoutSource(resolution.source)}). ` +
    `Set adapterConfig.timeoutSec to raise it.`
  );
}

/**
 * One-line start-of-run statement of the effective wall-clock timeout and its
 * source. Callers prefix with `[paperclip] ` and append a newline.
 */
export function formatAdapterExecutionTimeoutStartLogLine(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  if (resolution.timeoutSec <= 0) {
    if (resolution.source === "configured") {
      return (
        "Adapter execution timeout: none " +
        "(explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one)."
      );
    }
    return (
      "Adapter execution timeout: none " +
      "(no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one)."
    );
  }
  return (
    `Adapter execution timeout: timeoutSec=${resolution.timeoutSec} ` +
    `(${describeAdapterExecutionTimeoutSource(resolution.source)}; set adapterConfig.timeoutSec to override).`
  );
}

function requireSandboxRunner(target: AdapterSandboxExecutionTarget): CommandManagedRuntimeRunner {
  if (target.runner) return target.runner;
  throw new Error(
    "Sandbox execution target is missing its provider runtime runner. Sandbox commands must execute through the environment runtime.",
  );
}

function preferredSandboxShell(target: AdapterSandboxExecutionTarget): "bash" | "sh" {
  return preferredShellForSandbox(target.shellCommand);
}

type AdapterCommandCapableExecutionTarget = AdapterSshExecutionTarget | AdapterSandboxExecutionTarget;

function adapterExecutionTargetCommandRunner(target: AdapterCommandCapableExecutionTarget): CommandManagedRuntimeRunner {
  if (target.transport === "ssh") {
    return createSshCommandManagedRuntimeRunner({
      spec: target.spec,
      defaultCwd: target.remoteCwd,
      maxBufferBytes: DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES * 4,
    });
  }
  return requireSandboxRunner(target);
}

function adapterExecutionTargetShellCommand(target: AdapterCommandCapableExecutionTarget): "bash" | "sh" {
  return target.transport === "ssh" ? "sh" : preferredSandboxShell(target);
}

function adapterExecutionTargetTimeoutMs(
  target: AdapterCommandCapableExecutionTarget,
): number | null | undefined {
  return target.transport === "sandbox" ? target.timeoutMs : undefined;
}

export async function ensureAdapterExecutionTargetCommandResolvable(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { installCommand?: string | null; timeoutSec?: number | null } = {},
) {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    await ensureSandboxCommandResolvable(
      command,
      target,
      options.installCommand?.trim() || null,
      options.timeoutSec,
    );
    return;
  }
  await ensureCommandResolvable(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

async function probeSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
): Promise<{ resolved: boolean; timedOut: boolean; stderr: string }> {
  const runner = requireSandboxRunner(target);
  const probeScript = `command -v ${shellQuote(command)}`;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", probeScript],
    cwd: target.remoteCwd,
    timeoutMs: target.timeoutMs ?? 15_000,
  });
  return {
    resolved: !result.timedOut && (result.exitCode ?? 1) === 0,
    timedOut: result.timedOut,
    stderr: result.stderr.trim(),
  };
}

async function ensureSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
  installCommand: string | null,
  timeoutSec?: number | null,
): Promise<void> {
  // Probe whether the binary is resolvable inside the sandbox. We previously
  // short-circuited this for sandbox targets, which let the caller report a
  // success message even when the CLI was missing from the image. Now we run
  // a real `command -v` through the same runner the hello probe will use, so
  // the first step honestly reflects whether the binary is on PATH. The
  // sandbox provider is responsible for sourcing login profiles (e2b mirrors
  // SSH's buildSshSpawnTarget) so this and the hello probe agree on PATH.
  let probe = await probeSandboxCommandResolvable(command, target);
  if (probe.resolved) return;
  if (probe.timedOut) {
    throw new Error(`Timed out checking command "${command}" on sandbox target.`);
  }

  // If the caller supplied an install command, attempt the install once via
  // the sandbox runner (which the sandbox provider wraps in a login shell)
  // and re-probe before reporting failure. This lets fresh sandbox leases
  // bring up the CLI before the resolvability gate, mirroring the test path.
  let installFailureDetail: string | null = null;
  if (installCommand) {
    const runner = requireSandboxRunner(target);
    const installTimeoutMs =
      typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
        ? Math.floor(timeoutSec * 1000)
        : target.timeoutMs ?? 300_000;
    try {
      const installResult = await runner.execute({
        command: "sh",
        args: shellCommandArgs(installCommand),
        cwd: target.remoteCwd,
        timeoutMs: installTimeoutMs,
      });
      if (installResult.timedOut) {
        installFailureDetail = `install command timed out: ${installCommand}`;
      } else if ((installResult.exitCode ?? 0) !== 0) {
        const tail = (text: string) =>
          text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-2).join(" | ").slice(0, 240);
        const reason = tail(installResult.stderr || installResult.stdout) || `exit ${installResult.exitCode ?? "?"}`;
        installFailureDetail = `install command exited ${installResult.exitCode ?? "?"}: ${reason}`;
      }
    } catch (err) {
      installFailureDetail = `install command threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    probe = await probeSandboxCommandResolvable(command, target);
    if (probe.resolved) return;
    if (probe.timedOut) {
      throw new Error(`Timed out checking command "${command}" on sandbox target.`);
    }
  }

  const probeStderr = probe.stderr.length > 0 ? ` probe stderr: ${probe.stderr}` : "";
  const installDetail = installFailureDetail ? `; ${installFailureDetail}` : "";
  throw new Error(
    `Command "${command}" is not installed or not on PATH in the sandbox environment${installDetail}.${probeStderr}`,
  );
}

export async function resolveAdapterExecutionTargetCommandForLogs(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return `sandbox://${target.providerKey ?? "provider"}/${target.leaseId ?? "lease"}/${target.remoteCwd} :: ${command}`;
  }
  return await resolveCommandForLogs(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetProcess(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  args: string[],
  options: AdapterExecutionTargetProcessOptions,
): Promise<RunProcessResult> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    const runner = requireSandboxRunner(target);
    const env = sanitizeRemoteExecutionEnv(options.env);
    await options.onRuntimeProgress?.({
      phase: "adapter_startup",
      message: "Starting adapter in sandbox",
    });
    const runLogTail = options.runLogTail?.create() ?? null;
    let execCommand = command;
    let execArgs = args;
    if (runLogTail) {
      ({ command: execCommand, args: execArgs } = runLogTail.wrapCommand(command, args));
      runLogTail.start(options.onLog);
    }
    try {
      const result = await runner.execute({
        command: execCommand,
        args: execArgs,
        cwd: target.remoteCwd,
        env,
        stdin: options.stdin,
        timeoutMs: options.timeoutSec > 0 ? options.timeoutSec * 1000 : target.timeoutMs ?? undefined,
        // The tail loop already streams incremental chunks; suppress the
        // runner's end-of-run batched onLog to avoid duplicate log bytes.
        onLog: runLogTail ? undefined : options.onLog,
        onSpawn: options.onSpawn
          ? async (meta) => options.onSpawn?.({ ...meta, processGroupId: null })
          : undefined,
      });
      if (runLogTail) {
        await runLogTail.finish({ stdout: result.stdout, stderr: result.stderr });
      }
      return result;
    } catch (error) {
      if (runLogTail) {
        await runLogTail.abort();
      }
      throw error;
    }
  }

  const env =
    target?.kind === "remote" && target.transport === "ssh"
      ? sanitizeRemoteExecutionEnv(options.env)
      : options.env;

  return await runChildProcess(runId, command, args, {
    cwd: options.cwd,
    env,
    stdin: options.stdin,
    timeoutSec: options.timeoutSec,
    graceSec: options.graceSec,
    onLog: options.onLog,
    onSpawn: options.onSpawn,
    terminalResultCleanup: options.terminalResultCleanup,
    localProcessSandbox: target?.kind === "local" || !target ? options.localProcessSandbox : null,
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetShellCommand(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<RunProcessResult> {
  const onLog = options.onLog ?? (async () => {});
  if (target?.kind === "remote") {
    const startedAt = new Date().toISOString();
    const env = sanitizeRemoteExecutionEnv(options.env);
    if (target.transport === "ssh") {
      try {
        // Pass the raw command — `runSshCommand` owns profile sourcing and
        // the outer shell wrapper. Wrapping again here would nest a second
        // shell after the explicit `env KEY=VAL` overrides, re-sourcing
        // login profiles AFTER the override and silently undoing any
        // identity var (NVM_DIR / PATH / etc.) that a profile re-exports.
        const result = await runSshCommand(target.spec, command, {
          env,
          timeoutMs: (options.timeoutSec ?? 15) * 1000,
        });
        if (result.stdout) await onLog("stdout", result.stdout);
        if (result.stderr) await onLog("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const timedOutError = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          signal?: string | null;
        };
        const stdout = timedOutError.stdout ?? "";
        const stderr = timedOutError.stderr ?? "";
        if (typeof timedOutError.code === "number") {
          if (stdout) await onLog("stdout", stdout);
          if (stderr) await onLog("stderr", stderr);
          return {
            exitCode: timedOutError.code,
            signal: timedOutError.signal ?? null,
            timedOut: false,
            stdout,
            stderr,
            pid: null,
            startedAt,
          };
        }
        if (timedOutError.code !== "ETIMEDOUT") {
          throw error;
        }
        if (stdout) await onLog("stdout", stdout);
        if (stderr) await onLog("stderr", stderr);
        return {
          exitCode: null,
          signal: timedOutError.signal ?? null,
          timedOut: true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    }

    const shellCommand = preferredSandboxShell(target);
    return await requireSandboxRunner(target).execute({
      command: shellCommand,
      args: shellCommandArgs(command),
      cwd: target.remoteCwd,
      env,
      timeoutMs: (options.timeoutSec ?? 15) * 1000,
      onLog,
    });
  }

  return await runAdapterExecutionTargetProcess(
    runId,
    target,
    "sh",
    ["-lc", command],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: options.timeoutSec ?? 15,
      graceSec: options.graceSec ?? 5,
      onLog,
    },
  );
}

export interface AdapterSandboxInstallCommandCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  hint?: string;
}

// Best-effort run of an adapter-supplied install command on a sandbox target
// before the resolvability + hello probe. Returns null for non-sandbox
// targets so callers can no-op. Returns a structured check otherwise — never
// throws — so the rest of the test still runs and reports the post-install
// state honestly. Caller pushes the check into its result array; the test
// report shows whether install was attempted and what came back.
export async function maybeRunSandboxInstallCommand(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  installCommand: string;
  /** When provided, skip the install if `command -v <detectCommand>` succeeds. */
  detectCommand?: string | null;
  env?: Record<string, string>;
  timeoutSec?: number;
}): Promise<AdapterSandboxInstallCommandCheck | null> {
  const { target, adapterKey, installCommand } = input;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    return null;
  }
  const trimmed = installCommand.trim();
  if (trimmed.length === 0) return null;

  const code = `${adapterKey}_install_command_run`;

  // Skip install when the binary is already on PATH. Avoids running
  // network-dependent installers (e.g. `curl ... | bash`) on every test
  // probe when the CLI is preinstalled on the lease/template.
  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    try {
      const probe = await runAdapterExecutionTargetShellCommand(
        input.runId,
        target,
        `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
        {
          cwd: target.remoteCwd,
          env: input.env ?? {},
          timeoutSec: 30,
          graceSec: 5,
        },
      );
      if (!probe.timedOut && probe.exitCode === 0) {
        return {
          code,
          level: "info",
          message: `${detectCommand} already on PATH; skipped install.`,
        };
      }
    } catch {
      // Fall through to actually running the install — failure to probe
      // is not a reason to skip the install gate.
    }
  }

  let result;
  try {
    result = await runAdapterExecutionTargetShellCommand(input.runId, target, trimmed, {
      cwd: target.remoteCwd,
      env: input.env ?? {},
      timeoutSec: input.timeoutSec ?? 240,
      graceSec: 10,
    });
  } catch (err) {
    return {
      code,
      level: "warn",
      message: "Install command threw before completion.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const tail = (text: string) =>
    text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join(" | ").slice(0, 480);
  if (result.timedOut) {
    return {
      code,
      level: "warn",
      message: `Install command timed out: ${trimmed}`,
      detail: tail(result.stderr || result.stdout),
    };
  }
  if ((result.exitCode ?? 1) === 0) {
    return {
      code,
      level: "info",
      message: `Install command ran: ${trimmed}`,
      ...(tail(result.stdout) ? { detail: tail(result.stdout) } : {}),
    };
  }
  return {
    code,
    level: "warn",
    message: `Install command exited ${result.exitCode}: ${trimmed}`,
    detail: tail(result.stderr || result.stdout),
  };
}

export async function readAdapterExecutionTargetHomeDir(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  options: AdapterExecutionTargetShellOptions,
): Promise<string | null> {
  const result = await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    'printf %s "$HOME"',
    options,
  );
  const homeDir = result.stdout.trim();
  return homeDir.length > 0 ? homeDir : null;
}

export async function ensureAdapterExecutionTargetRuntimeCommandInstalled(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  installCommand?: string | null;
  detectCommand?: string | null;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: AdapterExecutionTargetShellOptions["onLog"];
}): Promise<void> {
  const installCommand = input.installCommand?.trim();
  if (!installCommand || input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return;
  }

  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    const probe = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!probe.timedOut && probe.exitCode === 0) {
      return;
    }
  }

  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    installCommand,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
      onLog: input.onLog,
    },
  );

  // A failed or timed-out install is not necessarily fatal: the CLI may already
  // be on PATH from a previous lease's install, the template image, or another
  // path entry. Re-run the detect probe (when one is configured) so a transient
  // install failure does not abort the agent run when the binary is reachable.
  const installFailed = result.timedOut || (result.exitCode ?? 0) !== 0;
  if (!installFailed) {
    return;
  }
  if (detectCommand) {
    const recheck = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!recheck.timedOut && recheck.exitCode === 0) {
      if (input.onLog) {
        const reason = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"}`;
        await input.onLog(
          "stderr",
          `[paperclip] Install command ${reason} (${installCommand}) but ${detectCommand} is on PATH; continuing.\n`,
        );
      }
      return;
    }
  }

  if (result.timedOut) {
    throw new Error(`Timed out while installing the adapter runtime command via: ${installCommand}`);
  }
  throw new Error(`Failed to install the adapter runtime command via: ${installCommand}`);
}

export async function ensureAdapterExecutionTargetFile(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  filePath: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && : > ${shellQuote(filePath)}`,
    options,
  );
}

/**
 * Ensure a working directory exists (and is a directory) on the execution target.
 *
 * For local targets this delegates to the local `ensureAbsoluteDirectory` helper
 * (Node fs). For remote (SSH/sandbox) targets it shells out and runs
 * `mkdir -p` (when allowed) followed by a `[ -d ]` check so the result reflects
 * the directory state inside the environment, not on the Paperclip host.
 *
 * Throws an Error with a human-readable message on failure.
 */
export async function ensureAdapterExecutionTargetDirectory(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  options: AdapterExecutionTargetShellOptions & { createIfMissing?: boolean },
): Promise<void> {
  const createIfMissing = options.createIfMissing ?? false;

  if (!target || target.kind === "local") {
    const { ensureAbsoluteDirectory } = await import("./server-utils.js");
    await ensureAbsoluteDirectory(cwd, { createIfMissing });
    return;
  }

  // Remote (SSH or sandbox): both expect POSIX absolute paths inside the env.
  if (!cwd.startsWith("/")) {
    throw new Error(`Working directory must be an absolute POSIX path on the remote target: "${cwd}"`);
  }

  const quoted = shellQuote(cwd);
  const script = createIfMissing
    ? `mkdir -p ${quoted} && [ -d ${quoted} ]`
    : `[ -d ${quoted} ]`;

  const result = await runAdapterExecutionTargetShellCommand(runId, target, script, {
    cwd: target.kind === "remote" ? target.remoteCwd : cwd,
    env: options.env,
    timeoutSec: options.timeoutSec ?? 15,
    graceSec: options.graceSec ?? 5,
    onLog: options.onLog,
  });

  if (result.timedOut) {
    throw new Error(`Timed out checking working directory on remote target: "${cwd}"`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    if (createIfMissing) {
      throw new Error(
        `Could not create working directory "${cwd}" on remote target${detail ? `: ${detail}` : "."}`,
      );
    }
    throw new Error(
      `Working directory does not exist on remote target: "${cwd}"${detail ? ` (${detail})` : ""}`,
    );
  }
}

export function adapterExecutionTargetSessionIdentity(
  target: AdapterExecutionTarget | null | undefined,
): Record<string, unknown> | null {
  if (!target || target.kind === "local") return null;
  if (target.transport === "ssh") return buildRemoteExecutionSessionIdentity(target.spec);
  return {
    transport: "sandbox",
    providerKey: target.providerKey ?? null,
    environmentId: target.environmentId ?? null,
    leaseId: target.leaseId ?? null,
    remoteCwd: target.remoteCwd,
  };
}

export function adapterExecutionTargetSessionMatches(
  saved: unknown,
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  if (!target || target.kind === "local") {
    return Object.keys(parseObject(saved)).length === 0;
  }
  if (target.transport === "ssh") return remoteExecutionSessionMatches(saved, target.spec);
  const current = adapterExecutionTargetSessionIdentity(target);
  const parsedSaved = parseObject(saved);
  return (
    readStringMeta(parsedSaved, "transport") === current?.transport &&
    readStringMeta(parsedSaved, "providerKey") === current?.providerKey &&
    readStringMeta(parsedSaved, "environmentId") === current?.environmentId &&
    readStringMeta(parsedSaved, "leaseId") === current?.leaseId &&
    readStringMeta(parsedSaved, "remoteCwd") === current?.remoteCwd
  );
}

export function parseAdapterExecutionTarget(value: unknown): AdapterExecutionTarget | null {
  const parsed = parseObject(value);
  const kind = readStringMeta(parsed, "kind");

  if (kind === "local") {
    return {
      kind: "local",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "ssh") {
    const spec = parseSshRemoteExecutionSpec(parseObject(parsed.spec));
    if (!spec) return null;
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd: spec.remoteCwd,
      spec,
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "sandbox") {
    const remoteCwd = readStringMeta(parsed, "remoteCwd");
    if (!remoteCwd) return null;
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: readStringMeta(parsed, "providerKey"),
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd,
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : null,
      streamRunLogs: typeof parsed.streamRunLogs === "boolean" ? parsed.streamRunLogs : null,
    };
  }

  return null;
}

export function adapterExecutionTargetFromRemoteExecution(
  remoteExecution: unknown,
  metadata: Pick<AdapterLocalExecutionTarget, "environmentId" | "leaseId"> = {},
): AdapterExecutionTarget | null {
  const parsed = parseObject(remoteExecution);
  const ssh = parseSshRemoteExecutionSpec(parsed);
  if (ssh) {
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: metadata.environmentId ?? null,
      leaseId: metadata.leaseId ?? null,
      remoteCwd: ssh.remoteCwd,
      spec: ssh,
    };
  }

  return null;
}

export function readAdapterExecutionTarget(input: {
  executionTarget?: unknown;
  legacyRemoteExecution?: unknown;
}): AdapterExecutionTarget | null {
  if (isAdapterExecutionTargetInstance(input.executionTarget)) {
    return input.executionTarget;
  }
  return (
    parseAdapterExecutionTarget(input.executionTarget) ??
    adapterExecutionTargetFromRemoteExecution(input.legacyRemoteExecution)
  );
}

export async function prepareAdapterExecutionTargetRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  workspaceLocalDir: string;
  timeoutSec?: number;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: AdapterManagedRuntimeAsset[];
  installCommand?: string | null;
  /** When provided alongside `installCommand`, skip the install if the binary is already on PATH. */
  detectCommand?: string | null;
  // Optional progress sink for the workspace/asset upload. The returned
  // `restoreWorkspace(onProgress?)` accepts its own sink for teardown. Both are
  // forwarded down to the transport so the sandbox/SSH children can attach byte
  // counters without further changes here.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  const target = input.target ?? { kind: "local" as const };
  if (target.kind === "local") {
    return {
      target,
      workspaceRemoteDir: null,
      runtimeRootDir: null,
      assetDirs: {},
      restoreWorkspace: async () => {},
    };
  }

  if (target.transport === "ssh") {
    const prepared = await prepareRemoteManagedRuntime({
      spec: target.spec,
      runId: input.runId,
      adapterKey: input.adapterKey,
      workspaceLocalDir: input.workspaceLocalDir,
      workspaceRemoteDir: input.workspaceRemoteDir,
      syncWorkspace: input.syncWorkspace,
      assets: input.assets,
      onProgress: input.onProgress,
    });
    return {
      target,
      workspaceRemoteDir: prepared.workspaceRemoteDir,
      runtimeRootDir: prepared.runtimeRootDir,
      assetDirs: prepared.assetDirs,
      restoreWorkspace: prepared.restoreWorkspace,
    };
  }

  const prepared = await prepareCommandManagedRuntime({
    runner: requireSandboxRunner(target),
    spec: {
      providerKey: target.providerKey,
      shellCommand: target.shellCommand,
      leaseId: target.leaseId,
      remoteCwd: target.remoteCwd,
      timeoutMs:
        input.timeoutSec && input.timeoutSec > 0
          ? input.timeoutSec * 1000
          : target.timeoutMs,
    },
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir: input.workspaceRemoteDir,
    syncWorkspace: input.syncWorkspace,
    workspaceExclude: input.workspaceExclude,
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    onProgress: input.onProgress,
    onRuntimeProgress: input.onRuntimeProgress,
  });
  return {
    target,
    workspaceRemoteDir: prepared.workspaceRemoteDir,
    runtimeRootDir: prepared.runtimeRootDir,
    assetDirs: prepared.assetDirs,
    restoreWorkspace: prepared.restoreWorkspace,
  };
}

export function runtimeAssetDir(
  prepared: Pick<PreparedAdapterExecutionTargetRuntime, "assetDirs">,
  key: string,
  fallbackRemoteCwd: string,
): string {
  return prepared.assetDirs[key] ?? path.posix.join(fallbackRemoteCwd, ".paperclip-runtime", key);
}

function buildBridgeResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified"]) {
    const value = response.headers.get(key);
    if (value && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

function buildBridgeForwardUrl(baseUrl: string, request: { path: string; query: string }): URL {
  const url = new URL(request.path, baseUrl);
  const query = request.query.trim();
  url.search = query.startsWith("?") ? query.slice(1) : query;
  return url;
}

function bridgeResponseBodyLimitError(maxBodyBytes: number): Error {
  return new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
}

async function readBridgeForwardResponseBody(response: Response, maxBodyBytes: number): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength) {
    const contentLength = Number.parseInt(rawContentLength, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

const PROCESS_SESSION_PROXY_SCRIPT = "paperclip-process-session-proxy.mjs";
const PROCESS_SESSION_REMOTE_SCRIPT = "paperclip-process-session-remote.mjs";
const PROCESS_SESSION_AUTH_TIMEOUT_MS = 5_000;
const PROCESS_SESSION_LAUNCH_RECONCILE_TIMEOUT_MS = 10_000;

interface ProcessSessionLaunchIdentity {
  schemaVersion: 1;
  launchId: string;
  sessionId: string;
  runId: string;
  adapterKey: string;
  createdAt: string;
}

interface ProcessSessionLaunchReconciliation {
  state: "accepted" | "not_started" | "ambiguous";
  identityPresent: boolean;
  identityMatches: boolean;
  launcherPid: number | null;
  wrapperPid: number | null;
  acceptedPresent: boolean;
  acceptedMatches: boolean;
  launcherAlive: boolean | null;
  wrapperAlive: boolean | null;
  childClosedPresent: boolean;
  wrapperDonePresent: boolean;
  terminalEventPresent: boolean;
  terminalReceiptPresent: boolean;
  terminalReceiptMatches: boolean;
  terminalReceiptComplete: boolean;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function splitJsonLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\n/);
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

async function writeProcessSessionProxyScript(dir: string, port: number, token: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const proxyPath = path.join(dir, PROCESS_SESSION_PROXY_SCRIPT);
  await fs.writeFile(proxyPath, getProcessSessionProxySource({ port, token }), { mode: 0o700 });
  return proxyPath;
}

// Content-hash-skip the process-session remote script write, mirroring the
// sandbox callback bridge entrypoint sha256 gate. The script is a static
// Paperclip-authored `.mjs` that only changes when the build changes, so on a
// warm start (same sandbox, script already present) the single sha-gate exec
// skips the ~3-exec base64 upload entirely. `syncRemoteTextFileWithHashSkip`
// fails loud on a check error rather than silently re-uploading.
async function syncProcessSessionRemoteScript(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  remoteScriptDir: string;
  remoteScriptPath: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ uploaded: boolean }> {
  const { uploaded } = await syncRemoteTextFileWithHashSkip({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    remoteDir: input.remoteScriptDir,
    remotePath: input.remoteScriptPath,
    body: getProcessSessionRemoteSource(),
    label: "Process session remote script",
    action: "sync process session remote script",
    lockDir: path.posix.join(input.remoteScriptDir, ".paperclip-process-session-script.lock"),
    timeoutMs: input.timeoutMs,
    shellCommand: input.shellCommand,
  });
  return { uploaded };
}

async function readRemoteJsonFiles(input: {
  client: ReturnType<typeof createCommandManagedSandboxCallbackBridgeQueueClient>;
  dir: string;
}): Promise<Array<{ name: string; body: string }>> {
  const names = await input.client.listJsonFiles(input.dir);
  const out: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    const filePath = path.posix.join(input.dir, name);
    const body = await input.client.readTextFile(filePath);
    await input.client.remove(filePath).catch(() => undefined);
    out.push({ name, body });
  }
  return out;
}

async function waitForLocalServerListen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Process session bridge did not expose a TCP port.");
  }
  return address.port;
}

function processSessionLaunchFailureDetail(input: {
  result: RunProcessResult | null;
  error: unknown;
}): string {
  if (input.error) {
    return `Initial launch transport failed: ${input.error instanceof Error ? input.error.message : String(input.error)}`;
  }
  if (!input.result) return "Initial launch transport returned no result.";
  const output = (input.result.stderr || input.result.stdout).trim();
  return [
    `Initial launch result timedOut=${String(input.result.timedOut)} exitCode=${String(input.result.exitCode)}.`,
    ...(output ? [output] : []),
  ].join(" ");
}

async function reconcileProcessSessionLaunch(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  launchId: string;
  sessionId: string;
  runId: string;
  adapterKey: string;
  launchIdentityPath: string;
  launcherPidPath: string;
  wrapperPidPath: string;
  launchAcceptedPath: string;
  terminalReceiptPath: string;
  childClosedPath: string;
  wrapperDonePath: string;
  eventsDir: string;
}): Promise<ProcessSessionLaunchReconciliation> {
  const probeSource = [
    'const fs = require("node:fs");',
    "const input = JSON.parse(process.argv[1]);",
    "const deadline = Date.now() + 5000;",
    "const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };",
    "const readJson = (file) => { const raw = readText(file); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };",
    "const readPid = (file) => { const value = Number(readText(file)); return Number.isInteger(value) && value > 0 ? value : null; };",
    "const isAlive = (pid) => {",
    "  if (!pid) return null;",
    "  try { process.kill(pid, 0); return true; }",
    "  catch (error) {",
    "    if (error && error.code === 'ESRCH') return false;",
    "    if (error && error.code === 'EPERM') return true;",
    "    return null;",
    "  }",
    "};",
    "const hasTerminalEvent = (dir) => {",
    "  let entries = [];",
    "  try { entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return false; }",
    "  return entries.some((name) => { const event = readJson(require('node:path').posix.join(dir, name)); return Boolean(event && event.type === 'exit'); });",
    "};",
    "const snapshot = () => {",
    "  const identity = readJson(input.launchIdentityPath);",
    "  const accepted = readJson(input.launchAcceptedPath);",
    "  const launcherPid = readPid(input.launcherPidPath);",
    "  const wrapperPid = readPid(input.wrapperPidPath);",
    "  const identityMatches = Boolean(identity && identity.schemaVersion === 1 && identity.launchId === input.launchId && identity.sessionId === input.sessionId && identity.runId === input.runId && identity.adapterKey === input.adapterKey);",
    "  const acceptedMatches = Boolean(accepted && accepted.schemaVersion === 1 && accepted.launchId === input.launchId && accepted.wrapperPid === wrapperPid);",
    "  const launcherAlive = isAlive(launcherPid);",
    "  const wrapperAlive = isAlive(wrapperPid);",
    "  const childClosedPresent = Boolean(readText(input.childClosedPath));",
    "  const wrapperDonePresent = Boolean(readText(input.wrapperDonePath));",
    "  const terminalEventPresent = hasTerminalEvent(input.eventsDir);",
    "  const terminalReceipt = readJson(input.terminalReceiptPath);",
    "  const terminalReceiptPresent = Boolean(terminalReceipt);",
    "  const terminalReceiptMatches = Boolean(terminalReceipt && terminalReceipt.schemaVersion === 1 && terminalReceipt.launchId === input.launchId && terminalReceipt.type === 'exit' && (terminalReceipt.code === null || Number.isInteger(terminalReceipt.code)) && (terminalReceipt.signal === null || typeof terminalReceipt.signal === 'string') && typeof terminalReceipt.timestamp === 'string' && terminalReceipt.timestamp.length > 0);",
    "  const terminalReceiptComplete = childClosedPresent && wrapperDonePresent && terminalReceiptMatches;",
    "  const safelyAccepted = identityMatches && acceptedMatches && Boolean(wrapperPid) && (wrapperAlive === true || terminalReceiptComplete);",
    "  return {",
    "    state: safelyAccepted ? 'accepted' : (!identity && !accepted && !launcherPid && !wrapperPid ? 'not_started' : 'ambiguous'),",
    "    identityPresent: Boolean(identity), identityMatches, launcherPid, wrapperPid, acceptedPresent: Boolean(accepted), acceptedMatches,",
    "    launcherAlive, wrapperAlive, childClosedPresent, wrapperDonePresent, terminalEventPresent, terminalReceiptPresent, terminalReceiptMatches, terminalReceiptComplete,",
    "  };",
    "};",
    "const poll = () => {",
    "  const result = snapshot();",
    "  if (result.state === 'accepted' || Date.now() >= deadline) {",
    "    process.stdout.write('PAPERCLIP_PROCESS_SESSION_RECONCILE=' + JSON.stringify(result) + '\\n');",
    "    return;",
    "  }",
    "  setTimeout(poll, 50);",
    "};",
    "poll();",
  ].join("\n");
  const result = await input.runner.execute({
    command: "node",
    args: [
      "-e",
      probeSource,
      JSON.stringify({
        launchId: input.launchId,
        sessionId: input.sessionId,
        runId: input.runId,
        adapterKey: input.adapterKey,
        launchIdentityPath: input.launchIdentityPath,
        launcherPidPath: input.launcherPidPath,
        wrapperPidPath: input.wrapperPidPath,
        launchAcceptedPath: input.launchAcceptedPath,
        terminalReceiptPath: input.terminalReceiptPath,
        childClosedPath: input.childClosedPath,
        wrapperDonePath: input.wrapperDonePath,
        eventsDir: input.eventsDir,
      }),
    ],
    cwd: input.remoteCwd,
    env: {
      PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
    },
    timeoutMs: PROCESS_SESSION_LAUNCH_RECONCILE_TIMEOUT_MS,
  });
  if (result.timedOut || (result.exitCode ?? 1) !== 0) {
    throw new Error(`Launch reconciliation probe failed: ${result.stderr || result.stdout}`);
  }
  const match = result.stdout.match(/^PAPERCLIP_PROCESS_SESSION_RECONCILE=(\{.*\})\r?$/m);
  if (!match?.[1]) {
    throw new Error("Launch reconciliation probe returned no parseable receipt.");
  }
  const parsed = JSON.parse(match[1]) as Partial<ProcessSessionLaunchReconciliation>;
  if (!(["accepted", "not_started", "ambiguous"] as const).includes(parsed.state as never)) {
    throw new Error("Launch reconciliation probe returned an invalid state.");
  }
  return parsed as ProcessSessionLaunchReconciliation;
}

async function cleanupNotStartedProcessSession(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  sessionDir: string;
  timeoutMs?: number;
}): Promise<void> {
  const cleanupSource = [
    'const fs = require("node:fs");',
    "const sessionDir = JSON.parse(process.argv[1]);",
    "fs.rmSync(sessionDir, { recursive: true, force: true });",
    "if (fs.existsSync(sessionDir)) throw new Error('process-session residue remains after cleanup');",
  ].join("\n");
  const result = await input.runner.execute({
    command: "node",
    args: ["-e", cleanupSource, JSON.stringify(input.sessionDir)],
    cwd: input.remoteCwd,
    env: {
      PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
    },
    timeoutMs: input.timeoutMs,
  });
  if (result.timedOut || (result.exitCode ?? 1) !== 0) {
    throw new Error(
      `Verified not-started process-session cleanup failed: ${result.stderr || result.stdout}`,
    );
  }
}

export async function reconcileAdapterExecutionTargetProcessSessionLaunchTerminal(input: {
  target: AdapterExecutionTarget | null | undefined;
  launchIdentity: AdapterExecutionTargetProcessSessionLaunchIdentity;
}): Promise<boolean> {
  const { target, launchIdentity } = input;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") return false;
  if (target.remoteCwd !== launchIdentity.remoteCwd) return false;
  if ((target.providerKey?.trim() || null) !== launchIdentity.providerKey) return false;
  if ((target.environmentId?.trim() || null) !== launchIdentity.environmentId) return false;
  if ((target.leaseId?.trim() || null) !== launchIdentity.leaseId) return false;

  const reconciliation = await reconcileProcessSessionLaunch({
    runner: requireSandboxRunner(target),
    remoteCwd: target.remoteCwd,
    launchId: launchIdentity.launchId,
    sessionId: launchIdentity.sessionId,
    runId: launchIdentity.runId,
    adapterKey: launchIdentity.adapterKey,
    launchIdentityPath: launchIdentity.launchIdentityPath,
    launcherPidPath: launchIdentity.launcherPidPath,
    wrapperPidPath: launchIdentity.wrapperPidPath,
    launchAcceptedPath: launchIdentity.launchAcceptedPath,
    terminalReceiptPath: launchIdentity.terminalReceiptPath,
    childClosedPath: launchIdentity.childClosedPath,
    wrapperDonePath: launchIdentity.wrapperDonePath,
    eventsDir: launchIdentity.eventsDir,
  });
  return (
    reconciliation.state === "accepted" &&
    reconciliation.identityMatches === true &&
    reconciliation.acceptedMatches === true &&
    reconciliation.terminalReceiptComplete === true &&
    reconciliation.launcherAlive === false &&
    reconciliation.wrapperAlive === false
  );
}

export async function startAdapterExecutionTargetProcessSessionBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  command: string;
  args: string[];
  cwd: string;
  // The launch env is consumed ONLY when building the base64 `commandPayload`
  // below — never during the env-INDEPENDENT dir/script setup. Accepting a
  // resolver (in addition to a plain object) lets a caller overlap that setup
  // with other work — e.g. starting the paperclip callback bridge — and hand the
  // merged env in right before the launch.
  env: Record<string, string> | (() => Promise<Record<string, string>>);
  timeoutSec?: number | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onLaunchState?: (state: AdapterExecutionTargetProcessSessionLaunchState) => Promise<void>;
}): Promise<AdapterExecutionTargetProcessSessionBridgeHandle | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const runner = requireSandboxRunner(target);
  if (runner.supportsConfidentialStdin !== true) {
    throw new Error(
      `Sandbox provider ${target.providerKey ?? "unknown"} does not advertise confidential stdin; ` +
        "refusing to dispatch the secret-bearing ACP process-session launch request.",
    );
  }
  if (
    runner.supportsProcessTreeCustody !== true ||
    typeof runner.reconcileProcessTreeCustody !== "function"
  ) {
    throw new Error(
      `Sandbox provider ${target.providerKey ?? "unknown"} does not advertise authoritative process-tree custody; ` +
        "remote ACP process-session launch is disabled before provider dispatch.",
    );
  }
  const shellCommand = preferredSandboxShell(target);
  const timeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : target.timeoutMs ?? undefined;
  const bridgeRuntimeDir = path.posix.join(
    input.runtimeRootDir?.trim() || path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey),
    "process-sessions",
  );
  const sessionId = randomUUID();
  const launchId = randomUUID();
  const sessionDir = path.posix.join(bridgeRuntimeDir, sessionId);
  const stdinDir = path.posix.join(sessionDir, "stdin");
  const eventsDir = path.posix.join(sessionDir, "events");
  const launchIdentityPath = path.posix.join(sessionDir, "launch.identity.json");
  const launcherPidPath = path.posix.join(sessionDir, "launcher.pid");
  const wrapperPidPath = path.posix.join(sessionDir, "wrapper.pid");
  const launchAcceptedPath = path.posix.join(sessionDir, "launch.accepted.json");
  const terminalReceiptPath = path.posix.join(sessionDir, "terminal.receipt.json");
  const childClosedPath = path.posix.join(sessionDir, "child.closed");
  const wrapperDonePath = path.posix.join(sessionDir, "wrapper.done");
  const launchIdentity: ProcessSessionLaunchIdentity = {
    schemaVersion: 1,
    launchId,
    sessionId,
    runId: input.runId,
    adapterKey: input.adapterKey,
    createdAt: new Date().toISOString(),
  };
  const ambiguousLaunchIdentity: AdapterExecutionTargetProcessSessionLaunchIdentity = {
    launchId,
    sessionId,
    runId: input.runId,
    adapterKey: input.adapterKey,
    transport: "sandbox",
    providerKey: target.providerKey?.trim() || null,
    environmentId: target.environmentId?.trim() || null,
    leaseId: target.leaseId?.trim() || null,
    remoteCwd: target.remoteCwd,
    sessionDir,
    eventsDir,
    launchIdentityPath,
    launcherPidPath,
    wrapperPidPath,
    launchAcceptedPath,
    terminalReceiptPath,
    childClosedPath,
    wrapperDonePath,
  };
  const remoteScriptPath = path.posix.join(bridgeRuntimeDir, PROCESS_SESSION_REMOTE_SCRIPT);
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({
    runner,
    remoteCwd: target.remoteCwd,
    timeoutMs,
    shellCommand,
  });
  const reconcileTerminalReceipt = () =>
    reconcileAdapterExecutionTargetProcessSessionLaunchTerminal({
      target,
      launchIdentity: ambiguousLaunchIdentity,
    });

  await client.makeDir(stdinDir);
  await client.makeDir(eventsDir);
  await syncProcessSessionRemoteScript({
    runner,
    remoteCwd: target.remoteCwd,
    remoteScriptDir: bridgeRuntimeDir,
    remoteScriptPath,
    timeoutMs,
    shellCommand,
  });

  // Resolve the launch env AFTER the env-independent setup above, so a caller
  // can defer it until an upstream dependency (e.g. the paperclip bridge's env)
  // is ready without blocking the dir/script setup.
  const launchEnv = typeof input.env === "function" ? await input.env() : input.env;
  const launchRequestPath = path.posix.join(sessionDir, "launch.request.json");
  const launchRequest = JSON.stringify({
    schemaVersion: 1,
    launchId,
    config: {
      command: input.command,
      args: input.args,
      cwd: input.cwd || target.remoteCwd,
      env: sanitizeRemoteExecutionEnv(launchEnv),
    },
  });

  await onLog("stdout", `[paperclip] Starting ACP process session bridge in sandbox (${target.providerKey ?? "provider"}).\n`);
  // This callback is the host's durable replay fence. It must commit before the
  // remote runner receives the launch mutation; a callback failure aborts here.
  await input.onLaunchState?.({
    status: "launching",
    acceptedStart: "unknown",
    retryable: false,
    launchIdentity: ambiguousLaunchIdentity,
  });
  let startResult: RunProcessResult | null = null;
  let startError: unknown = null;
  try {
    startResult = await runner.execute({
      command: shellCommand,
      args: shellCommandArgs(
        [
          "set -eu",
          "umask 077",
          `mkdir -p ${shellQuotePath(stdinDir)} ${shellQuotePath(eventsDir)}`,
          `chmod 700 ${shellQuotePath(sessionDir)} ${shellQuotePath(stdinDir)} ${shellQuotePath(eventsDir)}`,
          `rm -f ${shellQuotePath(launcherPidPath)} ${shellQuotePath(wrapperPidPath)} ${shellQuotePath(launchAcceptedPath)} ${shellQuotePath(terminalReceiptPath)} ${shellQuotePath(childClosedPath)} ${shellQuotePath(wrapperDonePath)} ${shellQuotePath(launchRequestPath)} ${shellQuotePath(`${launchRequestPath}.tmp`)}`,
          `printf '%s\\n' ${shellQuote(JSON.stringify(launchIdentity))} > ${shellQuotePath(`${launchIdentityPath}.tmp`)}`,
          `mv -f ${shellQuotePath(`${launchIdentityPath}.tmp`)} ${shellQuotePath(launchIdentityPath)}`,
          `cat > ${shellQuotePath(`${launchRequestPath}.tmp`)}`,
          `chmod 600 ${shellQuotePath(`${launchRequestPath}.tmp`)}`,
          `mv -f ${shellQuotePath(`${launchRequestPath}.tmp`)} ${shellQuotePath(launchRequestPath)}`,
          `PAPERCLIP_PROCESS_SESSION_DIR=${shellQuotePath(sessionDir)} ` +
            `PAPERCLIP_PROCESS_SESSION_LAUNCH_ID=${shellQuote(launchId)} ` +
            `PAPERCLIP_PROCESS_SESSION_REQUEST_PATH=${shellQuotePath(launchRequestPath)} ` +
            `nohup node ${shellQuotePath(remoteScriptPath)} >/dev/null 2>&1 < /dev/null &`,
          "launcher_pid=$!",
          `printf '%s\\n' "$launcher_pid" > ${shellQuotePath(`${launcherPidPath}.tmp`)}`,
          `mv -f ${shellQuotePath(`${launcherPidPath}.tmp`)} ${shellQuotePath(launcherPidPath)}`,
          "attempt=0",
          `while [ ! -s ${shellQuotePath(launchAcceptedPath)} ] && [ "$attempt" -lt 100 ]; do`,
          "  attempt=$((attempt + 1))",
          "  sleep 0.05",
          "done",
          `if [ ! -s ${shellQuotePath(launchAcceptedPath)} ]; then exit 1; fi`,
          "printf 'PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=%s\\n' \"$launcher_pid\"",
          `wrapper_pid=$(cat ${shellQuotePath(wrapperPidPath)})`,
          `if ! kill -0 "$wrapper_pid" 2>/dev/null; then exit 2; fi`,
          "printf 'PAPERCLIP_PROCESS_SESSION_WRAPPER_PID=%s\\n' \"$wrapper_pid\"",
        ].join("\n"),
      ),
      cwd: target.remoteCwd,
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
      stdin: launchRequest,
      timeoutMs,
    });
  } catch (error) {
    startError = error;
  }
  const launcherPidMatch = startResult?.stdout.match(/^PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=([1-9]\d*)\r?$/m);
  const wrapperPidMatch = startResult?.stdout.match(/^PAPERCLIP_PROCESS_SESSION_WRAPPER_PID=([1-9]\d*)\r?$/m);
  let remoteProcessSessionLauncherPid = launcherPidMatch?.[1] ?? null;
  let remoteProcessSessionWrapperPid = wrapperPidMatch?.[1] ?? null;
  const directLaunchAccepted =
    startError === null &&
    startResult !== null &&
    !startResult.timedOut &&
    (startResult.exitCode ?? 1) === 0 &&
    remoteProcessSessionLauncherPid !== null &&
    remoteProcessSessionWrapperPid !== null;
  if (!directLaunchAccepted) {
    let reconciliation: ProcessSessionLaunchReconciliation;
    try {
      reconciliation = await reconcileProcessSessionLaunch({
        runner,
        remoteCwd: target.remoteCwd,
        launchId,
        sessionId,
        runId: input.runId,
        adapterKey: input.adapterKey,
        launchIdentityPath,
        launcherPidPath,
        wrapperPidPath,
        launchAcceptedPath,
        terminalReceiptPath,
        childClosedPath,
        wrapperDonePath,
        eventsDir,
      });
    } catch (error) {
      throw new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
        ambiguousLaunchIdentity,
        `${processSessionLaunchFailureDetail({ result: startResult, error: startError })} ` +
          `The reconciliation probe also failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, reconcileTerminal: reconcileTerminalReceipt },
      );
    }
    if (
      reconciliation.state === "accepted" &&
      reconciliation.launcherPid &&
      reconciliation.wrapperPid &&
      (reconciliation.wrapperAlive === true || reconciliation.terminalReceiptComplete)
    ) {
      remoteProcessSessionLauncherPid = String(reconciliation.launcherPid);
      remoteProcessSessionWrapperPid = String(reconciliation.wrapperPid);
      await onLog(
        "stderr",
        `[paperclip] Reconciled ambiguous ACP process session launch ${launchId}; adopting durable wrapper ${remoteProcessSessionWrapperPid} (launcher ${remoteProcessSessionLauncherPid}).\n`,
      );
    } else if (reconciliation.state === "not_started") {
      // The exact identity/acceptance/PID readback proves no launch was
      // accepted. Remove the secret-bearing request and its session directory
      // before returning an ordinary start failure; cleanup failure must remain
      // loud because otherwise credentials would be left at rest remotely.
      await cleanupNotStartedProcessSession({
        runner,
        remoteCwd: target.remoteCwd,
        sessionDir,
        timeoutMs,
      });
      await input.onLaunchState?.({
        status: "not_started",
        acceptedStart: "unknown",
        retryable: true,
        launchIdentity: ambiguousLaunchIdentity,
      });
      throw new Error(
        `Failed to start sandbox ACP process session bridge: ${processSessionLaunchFailureDetail({
          result: startResult,
          error: startError,
        })}`,
      );
    } else {
      throw new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
        ambiguousLaunchIdentity,
        `${processSessionLaunchFailureDetail({ result: startResult, error: startError })} ` +
           `Reconciliation state=${reconciliation.state}, launcherPid=${String(reconciliation.launcherPid)}, ` +
          `wrapperPid=${String(reconciliation.wrapperPid)}, wrapperAlive=${String(reconciliation.wrapperAlive)}, ` +
          `acceptedMatches=${String(reconciliation.acceptedMatches)}, terminalReceiptComplete=${String(reconciliation.terminalReceiptComplete)}.`,
        { cause: startError ?? undefined, reconcileTerminal: reconcileTerminalReceipt },
      );
    }
  }
  if (!remoteProcessSessionLauncherPid || !remoteProcessSessionWrapperPid) {
    throw new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
      ambiguousLaunchIdentity,
      "Remote process identities were not available after launch reconciliation.",
      { reconcileTerminal: reconcileTerminalReceipt },
    );
  }
  try {
    await input.onLaunchState?.({
      status: "accepted",
      acceptedStart: "accepted",
      retryable: false,
      launchIdentity: ambiguousLaunchIdentity,
    });
  } catch (error) {
    // The remote launch is already accepted, but the host could not durably
    // advance its fence. Preserve the remote evidence and forbid replay.
    throw new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
      ambiguousLaunchIdentity,
      `The accepted launch could not be durably checkpointed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, acceptedStart: "accepted", reconcileTerminal: reconcileTerminalReceipt },
    );
  }

  let acceptedProxyAsset: PrivateExecutableAssetDirectory | null = null;
  let acceptedProxyServer: net.Server | null = null;
  let acceptedProxySockets: Set<net.Socket> | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  const cleanupAcceptedHostResources = async (): Promise<void> => {
    if (pollTimer) clearTimeout(pollTimer);
    for (const liveSocket of acceptedProxySockets ?? []) liveSocket.destroy();
    const cleanupSteps: Promise<unknown>[] = [];
    if (acceptedProxyServer?.listening) {
      cleanupSteps.push(
        new Promise<void>((resolve, reject) =>
          acceptedProxyServer!.close((closeError) =>
            closeError ? reject(closeError) : resolve(),
          ),
        ),
      );
    }
    if (acceptedProxyAsset) cleanupSteps.push(acceptedProxyAsset.cleanup());
    const results = await Promise.allSettled(cleanupSteps);
    const failures = rejectedReasons(results);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Accepted host proxy capability cleanup was not verified.");
    }
  };
  try {
  let socket: net.Socket | null = null;
  let stopping = false;
  let remoteTerminalSeen = false;
  let stdinSeq = 0;
  let inboundWriteChain: Promise<void> = Promise.resolve();
  const pendingRemoteEvents: Array<{
    type?: string;
    stream?: "stdout" | "stderr";
    data?: string;
    code?: number | null;
    signal?: string | null;
    message?: string;
  }> = [];
  // Establish and verify the private directory before generating or writing
  // the bearer token embedded in the executable proxy script.
  const proxyAsset = await createPrivateExecutableAssetDirectory({
    prefix: "paperclip-process-session-proxy",
  });
  acceptedProxyAsset = proxyAsset;
  const proxyDir = proxyAsset.directoryPath;
  const token = createSandboxCallbackBridgeToken(18);

  const writeRemoteEventToSocket = (event: (typeof pendingRemoteEvents)[number]) => {
    if (!socket) return false;
    socket.write(jsonLine(event));
    if (event.type === "exit") {
      stopping = true;
      socket.end();
    } else if (event.type === "error") {
      stopping = true;
      socket.destroy();
    }
    return true;
  };

  const deliverRemoteEvent = (event: (typeof pendingRemoteEvents)[number]) => {
    if (event.type === "exit" || event.type === "error") {
      remoteTerminalSeen = true;
    }
    if (socket) {
      writeRemoteEventToSocket(event);
      return;
    }
    pendingRemoteEvents.push(event);
    if (event.type === "exit" || event.type === "error") {
      stopping = true;
    }
  };

  const flushPendingRemoteEvents = () => {
    if (!socket) return;
    while (pendingRemoteEvents.length > 0 && socket) {
      const event = pendingRemoteEvents.shift();
      if (event) writeRemoteEventToSocket(event);
    }
  };

  const enqueueRemoteStdinEvent = (event: { type: "stdin"; data: string } | { type: "stdinEnd" }) => {
    stdinSeq += 1;
    const name = `${String(stdinSeq).padStart(12, "0")}.json`;
    const write = inboundWriteChain.then(async () => {
      await client.writeTextFile(path.posix.join(stdinDir, name), jsonLine(event));
    });
    // Preserve receipt order even when a provider-backed write spans several
    // remote commands. Keep the queue usable after an individual write fails;
    // the caller-facing branch below still reports that failure to the proxy.
    inboundWriteChain = write.catch(() => undefined);
    return write;
  };

  const liveSockets = new Set<net.Socket>();
  acceptedProxySockets = liveSockets;
  const server = net.createServer((nextSocket) => {
    liveSockets.add(nextSocket);
    nextSocket.setEncoding("utf8");
    nextSocket.on("error", () => undefined);
    let connectionBuffer = "";
    let authenticated = false;
    // Connections own the session (and receive buffered process output) only
    // after presenting the bridge token; idle unauthenticated peers are dropped.
    const authTimer = setTimeout(() => {
      if (!authenticated) nextSocket.destroy();
    }, PROCESS_SESSION_AUTH_TIMEOUT_MS);
    authTimer.unref?.();
    nextSocket.on("close", () => {
      clearTimeout(authTimer);
      liveSockets.delete(nextSocket);
    });
    nextSocket.on("data", (chunk) => {
      connectionBuffer += chunk;
      const split = splitJsonLines(connectionBuffer);
      connectionBuffer = split.rest;
      for (const line of split.lines) {
        if (!line.trim()) continue;
        let message: { token?: string; type?: string; data?: string };
        try {
          message = JSON.parse(line) as { token?: string; type?: string; data?: string };
        } catch {
          nextSocket.destroy();
          return;
        }
        if (message.token !== token) {
          nextSocket.destroy();
          return;
        }
        if (!authenticated) {
          if (socket) {
            nextSocket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          socket = nextSocket;
          flushPendingRemoteEvents();
        }
        const queuedWrite = message.type === "stdin" && typeof message.data === "string"
          ? enqueueRemoteStdinEvent({ type: "stdin", data: message.data })
          : message.type === "stdinEnd"
            ? enqueueRemoteStdinEvent({ type: "stdinEnd" })
            : null;
        void queuedWrite?.catch((error) => {
          nextSocket.write(jsonLine({ type: "error", message: error instanceof Error ? error.message : String(error) }));
          nextSocket.destroy();
        });
      }
    });
  });
  acceptedProxyServer = server;

  const poll = async () => {
    if (stopping) return;
    try {
      const events = await readRemoteJsonFiles({ client, dir: eventsDir });
      for (const event of events) {
        const parsed = JSON.parse(event.body) as {
          type?: string;
          stream?: "stdout" | "stderr";
          data?: string;
          code?: number | null;
          signal?: string | null;
          message?: string;
        };
        deliverRemoteEvent(parsed);
        if (parsed.type === "exit" || parsed.type === "error") return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await onLog("stderr", `[paperclip] ACP process session bridge poll failed: ${message}\n`);
      deliverRemoteEvent({ type: "error", message });
      return;
    } finally {
      if (!stopping) {
        pollTimer = setTimeout(() => void poll(), 100);
        pollTimer.unref?.();
      }
    }
  };

  const port = await waitForLocalServerListen(server);
  const agentCommand = await writeProcessSessionProxyScript(proxyDir, port, token);
  await proxyAsset.assertIntegrity();
  pollTimer = setTimeout(() => void poll(), 100);
  pollTimer.unref?.();
  let stopPromise: Promise<void> | null = null;
  let stopServerClosed = false;
  let stopStdinEndCheckpointed = false;

  return {
    agentCommand,
    launchIdentity: ambiguousLaunchIdentity,
    reconcileTerminal: reconcileTerminalReceipt,
    treeCustody: "unverified",
    stop: async () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const liveSocket of liveSockets) liveSocket.destroy();
      const serverClosed = stopServerClosed || !server.listening
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) =>
            server.close((closeError) => (closeError ? reject(closeError) : resolve())),
          );
      await inboundWriteChain;
      stdinSeq += 1;
      let stdinEndWritten = stopStdinEndCheckpointed;
      if (!stopStdinEndCheckpointed) {
        try {
          await client.writeTextFile(
            path.posix.join(stdinDir, `${String(stdinSeq).padStart(12, "0")}.json`),
            jsonLine({ type: "stdinEnd" }),
          );
          stopStdinEndCheckpointed = true;
          stdinEndWritten = true;
        } catch (error) {
          stdinEndWritten = false;
          await onLog(
            "stderr",
            `[paperclip] Failed to checkpoint ACP process session stdinEnd; preserving ${sessionDir}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      await serverClosed;
      stopServerClosed = true;
      // The remote helper consumes stdin events on a short polling cadence. Do
      // not delete its queue immediately after writing stdinEnd: doing so can
      // strand the child with its cwd open (EBUSY on Windows) and erase the only
      // graceful-stop signal. Drain until a terminal receipt or a bounded grace
      // deadline, then preserve the existing best-effort cleanup behavior.
      const stopDeadline = Date.now() + 2_000;
      while (!remoteTerminalSeen && Date.now() < stopDeadline) {
        const events = await readRemoteJsonFiles({ client, dir: eventsDir }).catch(() => []);
        for (const event of events) {
          const parsed = JSON.parse(event.body) as (typeof pendingRemoteEvents)[number];
          deliverRemoteEvent(parsed);
        }
        if (!remoteTerminalSeen) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // A terminal child event does not prove that the remote Node wrapper has
      // released its cwd and queue handles. Fence cleanup on that wrapper's
      // actual process identity; if it cannot be proven stopped, preserve the
      // session directory for recovery instead of racing a destructive remove.
      const wrapperExitProbeSource = [
        "const pids = JSON.parse(process.argv[1]);",
        "const deadline = Date.now() + 5000;",
        "const isAlive = (pid) => {",
        "  try { process.kill(pid, 0); return true; }",
        "  catch (error) { return !(error && error.code === 'ESRCH'); }",
        "};",
        "const poll = () => {",
        "  if (!pids.some(isAlive)) process.exit(0);",
        "  if (Date.now() >= deadline) process.exit(1);",
        "  setTimeout(poll, 50);",
        "};",
        "poll();",
      ].join("\n");
      const wrapperExit = await runner.execute({
        command: "node",
        args: [
          "-e",
          wrapperExitProbeSource,
          JSON.stringify([...new Set([remoteProcessSessionLauncherPid, remoteProcessSessionWrapperPid].map(Number))]),
        ],
        cwd: target.remoteCwd,
        env: {
          PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
        },
        timeoutMs: 10_000,
      }).catch((error) => ({
        exitCode: 1,
        timedOut: false,
        stderr: error instanceof Error ? error.message : String(error),
      }));
      const wrapperExitProven = !wrapperExit.timedOut && (wrapperExit.exitCode ?? 1) === 0;
      if (stdinEndWritten && wrapperExitProven) {
        await onLog(
          "stderr",
          `[paperclip] ACP process session ${sessionDir} reached direct-wrapper terminal proof; preserving durable evidence until post-DB acknowledgment and process-tree custody are available.\n`,
        );
      } else if (!wrapperExitProven) {
        await onLog(
          "stderr",
          `[paperclip] ACP process session wrapper ${remoteProcessSessionWrapperPid} (launcher ${remoteProcessSessionLauncherPid}) did not exit within the cleanup grace; preserving ${sessionDir}.\n`,
        );
      } else {
        await onLog(
          "stderr",
          `[paperclip] ACP process session wrapper exited but stdinEnd checkpoint was not verified; preserving ${sessionDir}.\n`,
        );
      }
      await proxyAsset.cleanup();
      })().catch((error) => {
        stopPromise = null;
        throw error;
      });
      return stopPromise;
    },
  };
  } catch (error) {
    if (isAdapterExecutionTargetProcessSessionLaunchAmbiguousError(error)) throw error;
    let proxyCleanupError: unknown = null;
    try {
      await cleanupAcceptedHostResources();
    } catch (cleanupError) {
      proxyCleanupError = cleanupError;
    }
    // Dispatch was durably accepted before any of this host-side proxy setup
    // began. A local setup failure cannot make the remote child safe to replay,
    // so preserve the durable launch identity and force explicit reconciliation.
    throw new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
      ambiguousLaunchIdentity,
      `Host proxy setup failed after the remote launch was accepted: ${error instanceof Error ? error.message : String(error)}` +
        (proxyCleanupError
          ? ` Host private proxy cleanup was not verified: ${
              proxyCleanupError instanceof Error ? proxyCleanupError.message : String(proxyCleanupError)
            }`
          : ""),
      {
        cause: proxyCleanupError
          ? new AggregateError([error, proxyCleanupError], "Host proxy setup and cleanup both failed")
          : error,
        acceptedStart: "accepted",
        reconcileTerminal: reconcileTerminalReceipt,
        cleanupAcceptedHostResources: proxyCleanupError
          ? cleanupAcceptedHostResources
          : undefined,
      },
    );
  }
}

function getProcessSessionProxySource(input: { port: number; token: string }): string {
  return `#!/usr/bin/env node
import net from "node:net";

const socket = net.createConnection({ host: "127.0.0.1", port: ${input.port} });
const token = ${JSON.stringify(input.token)};
let buffer = "";
let exiting = false;
let stdinEnded = false;

function send(message) {
  socket.write(JSON.stringify({ token, ...message }) + "\\n");
}

socket.on("connect", () => send({ type: "hello" }));
process.stdin.on("data", (chunk) => send({ type: "stdin", data: Buffer.from(chunk).toString("base64") }));
function sendStdinEnd() {
  if (stdinEnded) return;
  stdinEnded = true;
  send({ type: "stdinEnd" });
}
process.stdin.on("end", sendStdinEnd);
// Windows pipe shutdown can surface as close without a preceding end event.
// Give any already-buffered data event one turn to enqueue before the fallback
// EOF; TCP ordering then keeps stdin data ahead of stdinEnd on the controller.
process.stdin.on("close", () => setTimeout(sendStdinEnd, 50));
process.stdin.resume();

socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split(/\\n/);
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "data") {
      const out = Buffer.from(message.data || "", "base64");
      (message.stream === "stderr" ? process.stderr : process.stdout).write(out);
    } else if (message.type === "error") {
      process.stderr.write(String(message.message || "Process session bridge failed.") + "\\n");
      exiting = true;
      process.exitCode = 1;
      socket.end();
    } else if (message.type === "exit") {
      exiting = true;
      process.exitCode = typeof message.code === "number" ? message.code : 1;
      socket.end();
    }
  }
});
socket.on("close", () => {
  if (!exiting) process.exit(1);
});
`;
}

function getProcessSessionRemoteSource(): string {
  return `import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;
const launchId = process.env.PAPERCLIP_PROCESS_SESSION_LAUNCH_ID;
const launchRequestPath = process.env.PAPERCLIP_PROCESS_SESSION_REQUEST_PATH;
if (!sessionDir || !launchId || !launchRequestPath) throw new Error("Missing process session bridge env.");

const stdinDir = path.posix.join(sessionDir, "stdin");
const eventsDir = path.posix.join(sessionDir, "events");
let seq = 0;
let stdinClosed = false;

const launchRequestRaw = await fs.readFile(launchRequestPath, "utf8");
const launchRequest = JSON.parse(launchRequestRaw);
if (launchRequest.schemaVersion !== 1 || launchRequest.launchId !== launchId || !launchRequest.config) {
  throw new Error("Invalid process session launch request identity.");
}
const config = launchRequest.config;
await fs.rm(launchRequestPath, { force: true });
await fs.mkdir(stdinDir, { recursive: true });
await fs.mkdir(eventsDir, { recursive: true });
const wrapperPidPath = path.posix.join(sessionDir, "wrapper.pid");
const wrapperPidTempPath = wrapperPidPath + ".tmp";
await fs.writeFile(wrapperPidTempPath, String(process.pid) + "\\n", "utf8");
await fs.rename(wrapperPidTempPath, wrapperPidPath);
let writeChain = Promise.resolve();

function writeEvent(event) {
  seq += 1;
  const file = path.posix.join(eventsDir, String(seq).padStart(12, "0") + ".json");
  const write = writeChain.then(async () => {
    await fs.writeFile(file + ".tmp", JSON.stringify(event) + "\\n", "utf8");
    await fs.rename(file + ".tmp", file);
  });
  writeChain = write.catch(() => undefined);
  return write;
}

const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
  cwd: config.cwd || process.cwd(),
  env: { ...process.env, ...(config.env || {}) },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => void writeEvent({ type: "data", stream: "stdout", data: Buffer.from(chunk).toString("base64") }));
child.stderr.on("data", (chunk) => void writeEvent({ type: "data", stream: "stderr", data: Buffer.from(chunk).toString("base64") }));
child.on("error", (error) => void writeEvent({ type: "error", message: error.message }));
let reconcileChildTerminal = () => {};
const childClosed = new Promise((resolve) => {
  let terminalWritten = false;
  let drainTimer;
  const writeTerminal = (code, signal) => {
    if (terminalWritten) return;
    terminalWritten = true;
    if (drainTimer) clearTimeout(drainTimer);
    void (async () => {
      const terminalReceiptPath = path.posix.join(sessionDir, "terminal.receipt.json");
      const terminalReceiptTempPath = terminalReceiptPath + ".tmp";
      await fs.writeFile(terminalReceiptTempPath, JSON.stringify({
        schemaVersion: 1,
        launchId,
        type: "exit",
        code,
        signal,
        timestamp: new Date().toISOString(),
      }) + "\\n", "utf8");
      await fs.rename(terminalReceiptTempPath, terminalReceiptPath);
      await writeEvent({ type: "exit", code, signal });
      await fs.writeFile(path.posix.join(sessionDir, "child.closed"), new Date().toISOString() + "\\n", "utf8");
    })().finally(resolve);
  };
  // Prefer close so stdout/stderr drain before the terminal receipt. Windows
  // descendants can inherit those pipe handles after the direct child exits,
  // so bound that drain rather than retaining the wrapper cwd indefinitely.
  child.on("exit", (code, signal) => {
    drainTimer = setTimeout(() => writeTerminal(code, signal), 1000);
  });
  child.on("close", writeTerminal);
  reconcileChildTerminal = () => {
    setTimeout(() => {
      try {
        process.kill(child.pid, 0);
      } catch (error) {
        if (!error || error.code !== "EPERM") {
          writeTerminal(child.exitCode ?? 1, child.signalCode ?? null);
        }
      }
    }, 1000);
  };
});

// Acceptance is an external-operation receipt: publish it only after spawn()
// returned and all child terminal listeners are attached. A wrapper crash before
// this point is therefore never mistaken for an accepted ACP child launch.
const launchAcceptedPath = path.posix.join(sessionDir, "launch.accepted.json");
const launchAcceptedTempPath = launchAcceptedPath + ".tmp";
await fs.writeFile(launchAcceptedTempPath, JSON.stringify({
  schemaVersion: 1,
  launchId,
  wrapperPid: process.pid,
  childPid: Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null,
  acceptedAt: new Date().toISOString(),
}) + "\\n", "utf8");
await fs.rename(launchAcceptedTempPath, launchAcceptedPath);

async function pollStdin() {
  while (!stdinClosed) {
    const entries = (await fs.readdir(stdinDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      const file = path.posix.join(stdinDir, name);
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.type === "stdin" && typeof message.data === "string") {
        child.stdin.write(Buffer.from(message.data, "base64"));
      } else if (message.type === "stdinEnd") {
        stdinClosed = true;
        await fs.writeFile(path.posix.join(sessionDir, "stdin.closed"), new Date().toISOString() + "\\n", "utf8");
        child.stdin.end();
        reconcileChildTerminal();
        break;
      }
    }
    if (!stdinClosed) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const stdinPolling = pollStdin().catch(async (error) => {
  await writeEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
  stdinClosed = true;
  child.stdin.end();
  reconcileChildTerminal();
});

// The wrapper is itself a durable execution unit: do not disappear until the
// controller's stdinEnd is consumed and the child's terminal receipt is on
// disk. Explicit exit avoids Windows/MSYS nohup retaining the wrapper cwd even
// after every JavaScript handle appears drained.
await Promise.all([stdinPolling, childClosed]);
await writeChain;
await fs.writeFile(path.posix.join(sessionDir, "wrapper.done"), new Date().toISOString() + "\\n", "utf8");
process.exit(0);
`;
}

export async function startAdapterExecutionTargetPaperclipBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  timeoutSec?: number | null;
  hostApiToken: string | null | undefined;
  hostApiUrl?: string | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  maxBodyBytes?: number | null;
}): Promise<AdapterExecutionTargetPaperclipBridgeHandle | null> {
  if (!adapterExecutionTargetUsesPaperclipBridge(input.target)) {
    return null;
  }
  if (!input.target || input.target.kind !== "remote") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const hostApiToken = input.hostApiToken?.trim() ?? "";
  if (hostApiToken.length === 0) {
    throw new Error("Sandbox bridge mode requires a host-side Paperclip API token.");
  }

  const runtimeRootDir =
    input.runtimeRootDir?.trim().length
      ? input.runtimeRootDir.trim()
      : path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey);
  const bridgeRuntimeDir = path.posix.join(runtimeRootDir, "paperclip-bridge");
  const queueDir = path.posix.join(bridgeRuntimeDir, "queue");
  const assetRemoteDir = path.posix.join(bridgeRuntimeDir, "server");
  const bridgeToken = createSandboxCallbackBridgeToken();
  const maxBodyBytes =
    typeof input.maxBodyBytes === "number" && Number.isFinite(input.maxBodyBytes) && input.maxBodyBytes > 0
      ? Math.trunc(input.maxBodyBytes)
      : DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const hostApiUrl =
    input.hostApiUrl?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    resolveDefaultPaperclipApiUrl();
  const shellCommand = adapterExecutionTargetShellCommand(target);
  const runner = adapterExecutionTargetCommandRunner(target);
  const bridgeTimeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : adapterExecutionTargetTimeoutMs(target);

  await onLog(
    "stdout",
    `[paperclip] Starting sandbox callback bridge for ${input.adapterKey} in ${bridgeRuntimeDir}.\n`,
  );

  const bridgeAsset = await createSandboxCallbackBridgeAsset();
  let server: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | null = null;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | null = null;
  try {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: target.remoteCwd,
      timeoutMs: bridgeTimeoutMs,
      shellCommand,
    });
    // PAPERCLIP_BRIDGE_DEBUG opts into verbose stdout logs of every bridge
    // proxy request/response. The query string is logged verbatim, so callers
    // who pass auth tokens or other sensitive values as query parameters
    // should be aware those values appear in the host process's stdout when
    // this flag is enabled. Only intended for active debugging in trusted
    // environments.
    const bridgeDebugEnabled = isBridgeDebugEnabled(process.env);
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      maxBodyBytes,
      handleRequest: async (request) => {
        const method = request.method.trim().toUpperCase() || "GET";
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value.trim().length === 0) continue;
          headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${hostApiToken}`);
        headers.set("x-paperclip-run-id", input.runId);
        const response = await fetch(buildBridgeForwardUrl(hostApiUrl, request), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
          signal: AbortSignal.timeout(30_000),
        });
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy response ${response.status} for ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        return {
          status: response.status,
          headers: buildBridgeResponseHeaders(response),
          body: await readBridgeForwardResponseBody(response, maxBodyBytes),
        };
      },
    });
    server = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: target.remoteCwd,
      assetRemoteDir,
      queueDir,
      bridgeToken,
      bridgeAsset,
      timeoutMs: bridgeTimeoutMs,
      maxBodyBytes,
      shellCommand,
    });
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      server?.stop(),
      worker?.stop(),
      bridgeAsset.cleanup(),
    ]);
    const cleanupFailures = rejectedReasons(cleanupResults);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Sandbox callback bridge startup failed and capability revocation was not verified.",
      );
    }
    throw error;
  }

  let runLogTail: SandboxRunLogTailFactory | null = null;
  if (target.transport === "sandbox" && target.streamRunLogs !== false) {
    runLogTail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: target.remoteCwd,
      logsDir: sandboxCallbackBridgeDirectories(queueDir).logsDir,
      shellCommand,
    });
    await onLog("stdout", "[paperclip] Sandbox run log streaming enabled for this run.\n");
  }

  return {
    env: {
      PAPERCLIP_API_URL: server.baseUrl,
      PAPERCLIP_API_KEY: bridgeToken,
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
    },
    runLogTail,
    stop: async () => {
      const serverStopResults = await Promise.allSettled([
        server?.stop(),
      ]);
      const remainingStopResults = await Promise.allSettled([
        worker?.stop(),
        bridgeAsset.cleanup(),
      ]);
      const stopFailures = rejectedReasons([...serverStopResults, ...remainingStopResults]);
      if (stopFailures.length > 0) {
        throw new AggregateError(
          stopFailures,
          "Sandbox callback bridge capability revocation was not verified.",
        );
      }
    },
  };
}
