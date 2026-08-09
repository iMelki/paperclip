import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { createPrivateExecutableAssetDirectory } from "./private-executable-asset.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import {
  dirnamePortablePath,
  joinPortablePath,
  shellQuote,
  shellQuotePath,
} from "./shell-path.js";
import type { RunProcessResult } from "./server-utils.js";

const DEFAULT_BRIDGE_TOKEN_BYTES = 24;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 100;
const DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_BRIDGE_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_BRIDGE_MAX_QUEUE_DEPTH = 64;
const DEFAULT_BRIDGE_MAX_BODY_BYTES = 256 * 1024;
const SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT = "paperclip-bridge-server.mjs";
const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";
const SANDBOX_CALLBACK_BRIDGE_NONCE_ARG = "--paperclip-bridge-instance-nonce=";
const SANDBOX_CALLBACK_BRIDGE_SCRIPT_MARKER_ARG = "--paperclip-bridge-script-marker=";
const SANDBOX_CALLBACK_BRIDGE_PROCESS_IDENTITY_SCHEMA = "paperclip-sandbox-callback-process/v1";
const SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA = "paperclip-sandbox-callback-cancel/v1";
const SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA = "paperclip-sandbox-callback-cancelled/v1";
const SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA = "paperclip-sandbox-callback-launch/v1";
const SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA = "paperclip-sandbox-callback-dispatch-claim/v1";

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES = DEFAULT_BRIDGE_MAX_BODY_BYTES;

export interface SandboxCallbackBridgeRouteRule {
  method: string;
  path: RegExp;
}

// Routes the in-sandbox heartbeat skill is documented to call. The server
// still enforces actor-level permissions on top of this allowlist; the list
// exists to bound the surface area a compromised CLI could reach via the
// reverse bridge. Keep this in sync with the Paperclip skill in
// `skills/paperclip/SKILL.md` and `references/api-reference.md`.
export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST: readonly SandboxCallbackBridgeRouteRule[] = [
  // Identity, inbox, agent self-management
  { method: "GET", path: /^\/api\/agents\/me$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox-lite$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox\/mine$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/skills$/ },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/skills\/sync$/ },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+\/instructions-path$/ },

  // Company-level reads used to discover work and context
  { method: "GET", path: /^\/api\/companies\/[^/]+$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/dashboard$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/agents$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/projects$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/goals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/org$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/approvals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/skills$/ },
  { method: "GET", path: /^\/api\/projects\/[^/]+$/ },
  { method: "GET", path: /^\/api\/goals\/[^/]+$/ },

  // Issue lifecycle: read context, checkout, update, comment, document, release
  { method: "GET", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/heartbeat-context$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/comments(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents(?:\/[^/]+)?$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+\/revisions$/ },
  { method: "PUT", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/checkout$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/release$/ },
  { method: "PATCH", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/approvals$/ },

  // Work products: publish branch/commit/artifact metadata for completed work.
  { method: "GET", path: /^\/api\/issues\/[^/]+\/work-products$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/work-products$/ },
  { method: "PATCH", path: /^\/api\/work-products\/[^/]+$/ },

  // Issue-thread interactions (suggest tasks, ask questions, request confirmation)
  { method: "GET", path: /^\/api\/issues\/[^/]+\/interactions(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions\/[^/]+\/(?:accept|reject|respond)$/ },

  // Subtasks / delegation
  { method: "POST", path: /^\/api\/companies\/[^/]+\/issues$/ },

  // Approvals (request, read, comment)
  { method: "GET", path: /^\/api\/approvals\/[^/]+$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/approvals$/ },

  // Execution workspaces and runtime services (start/stop/restart dev servers)
  { method: "GET", path: /^\/api\/execution-workspaces\/[^/]+$/ },
  { method: "POST", path: /^\/api\/execution-workspaces\/[^/]+\/runtime-services\/(?:start|stop|restart)$/ },

  // Routines (agents manage their own routines and triggers)
  { method: "GET", path: /^\/api\/routines\/[^/]+$/ },
  { method: "GET", path: /^\/api\/routines\/[^/]+\/runs$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[^/]+$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/run$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/triggers$/ },
  { method: "PATCH", path: /^\/api\/routine-triggers\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/routine-triggers\/[^/]+$/ },
] as const;

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
] as const;

export interface SandboxCallbackBridgeRequest {
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /**
   * UTF-8 body contents. The bridge rejects non-JSON request bodies; binary
   * payloads are intentionally out of scope for this queue protocol.
   */
  body: string;
  createdAt: string;
}

export interface SandboxCallbackBridgeResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  completedAt: string;
}

export interface SandboxCallbackBridgeAsset {
  localDir: string;
  entrypoint: string;
  cleanup(): Promise<void>;
}

export interface SandboxCallbackBridgeDirectories {
  rootDir: string;
  requestsDir: string;
  responsesDir: string;
  logsDir: string;
  readyFile: string;
  pidFile: string;
  cancelFile: string;
  cancelAckFile: string;
  launchFile: string;
  dispatchClaimFile: string;
  logFile: string;
}

export interface SandboxCallbackBridgeQueueClient {
  makeDir(remotePath: string): Promise<void>;
  listJsonFiles(remotePath: string): Promise<string[]>;
  readTextFile(remotePath: string): Promise<string>;
  writeTextFile(remotePath: string, body: string): Promise<void>;
  writeResponseFile?(
    responsePath: string,
    body: string,
    options?: {
      requestPath?: string | null;
    },
  ): Promise<{ wrote: boolean }>;
  rename(fromPath: string, toPath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

export interface SandboxCallbackBridgeWorkerHandle {
  stop(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface StartedSandboxCallbackBridgeServer {
  baseUrl: string;
  host: string;
  port: number;
  pid: number;
  /** Diagnostic only. Parent lifetime never grants or revokes signal authority. */
  parentPid: number;
  readonly processIdentity: SandboxCallbackBridgeProcessIdentity;
  directories: SandboxCallbackBridgeDirectories;
  stop(): Promise<void>;
}

export interface SandboxCallbackBridgeProcessIdentity {
  readonly schema: typeof SANDBOX_CALLBACK_BRIDGE_PROCESS_IDENTITY_SCHEMA;
  readonly platform: "linux" | "win32";
  readonly pid: number;
  readonly bootIdentity: string;
  readonly osStartIdentity: string;
  readonly executablePath: string;
  readonly scriptMarker: string;
  readonly instanceNonce: string;
}

export interface SandboxCallbackBridgeCancellationController {
  readonly instanceNonce: string;
  readonly directories: Readonly<SandboxCallbackBridgeDirectories>;
  readonly acceptedProcessIdentity: SandboxCallbackBridgeProcessIdentity | null;
  cancel(): Promise<"cancelled">;
  reconcile(): Promise<"cancelled">;
}

export interface RehydrateSandboxCallbackBridgeCancellationControllerInput {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  directories: SandboxCallbackBridgeDirectories;
  instanceNonce: string;
  scriptMarker: string;
  processIdentity: SandboxCallbackBridgeProcessIdentity;
  timeoutMs?: number | null;
  nodeCommand?: string;
}

export interface DiscoverSandboxCallbackBridgeCancellationAuthorityInput {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  queueDir: string;
  instanceNonce: string;
  timeoutMs?: number | null;
  nodeCommand?: string;
}

export type SandboxCallbackBridgeCancellationAuthorityDiscovery =
  | Readonly<{
    status: "accepted";
    replaySafe: false;
    instanceNonce: string;
    scriptMarker: string;
    processIdentity: SandboxCallbackBridgeProcessIdentity;
    directories: Readonly<SandboxCallbackBridgeDirectories>;
    cancellationController: SandboxCallbackBridgeCancellationController;
  }>
  | Readonly<{
    status: "accepted_receipt_absent";
    replaySafe: false;
    reason: "launch_receipt_missing" | "launch_not_accepted";
    instanceNonce: string;
    scriptMarker: string | null;
    processIdentity: null;
    directories: Readonly<SandboxCallbackBridgeDirectories>;
    cancellationController: SandboxCallbackBridgeCancellationController | null;
  }>
  | Readonly<{
    status: "conflict";
    replaySafe: false;
    reason: string;
    instanceNonce: string;
    scriptMarker: null;
    processIdentity: null;
    directories: Readonly<SandboxCallbackBridgeDirectories>;
    cancellationController: null;
  }>;

/**
 * Launch may have been accepted but cleanup proof was unavailable. The bound
 * controller is the only retry/reconciliation authority; replaying launch is
 * forbidden until it succeeds.
 */
export class SandboxCallbackBridgeLaunchAmbiguousError extends AggregateError {
  readonly code = "SANDBOX_CALLBACK_BRIDGE_LAUNCH_AMBIGUOUS";
  readonly retryable = false;
  readonly needsReconciliation = true;
  readonly instanceNonce: string;
  readonly directories: Readonly<SandboxCallbackBridgeDirectories>;
  readonly cancellationController: SandboxCallbackBridgeCancellationController;
  readonly acceptedStart: "unknown" | "accepted";

  get acceptedProcessIdentity(): SandboxCallbackBridgeProcessIdentity | null {
    return this.cancellationController.acceptedProcessIdentity;
  }

  constructor(input: {
    detail: string;
    causes: readonly unknown[];
    controller: SandboxCallbackBridgeCancellationController;
    acceptedStart?: "unknown" | "accepted";
  }) {
    const causes = Object.freeze([...input.causes]);
    super(
      causes,
      `Sandbox callback bridge launch ${input.controller.instanceNonce} is ambiguous; ` +
        `do not replay launch until cancellation reconciliation succeeds. ${input.detail}`,
      { cause: causes.at(-1) },
    );
    this.name = "SandboxCallbackBridgeLaunchAmbiguousError";
    this.instanceNonce = input.controller.instanceNonce;
    this.directories = input.controller.directories;
    this.cancellationController = input.controller;
    this.acceptedStart = input.acceptedStart ?? "unknown";
  }
}

export interface WindowsCimProcessIdentityFixture {
  status: "present" | "absent";
  pid?: number;
  bootIdentity?: string;
  osStartIdentity?: string;
  executablePath?: string;
  commandLine?: string;
}

/** Parse Linux /proc/<pid>/stat field 22 without assuming the comm field has no spaces or parentheses. */
export function parseLinuxProcStatStartIdentity(stat: string): string | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fieldsFromState = stat.slice(commEnd + 1).trim().split(/\s+/);
  const startTime = fieldsFromState[19];
  return typeof startTime === "string" && /^\d+$/.test(startTime) ? startTime : null;
}

/** Strict parser used by the Windows CIM probe and fixture tests. */
export function parseWindowsCimProcessIdentityFixture(
  raw: string,
): WindowsCimProcessIdentityFixture | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.status === "absent") return { status: "absent" };
  if (
    value.status !== "present" ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.bootIdentity !== "string" ||
    value.bootIdentity.length === 0 ||
    typeof value.osStartIdentity !== "string" ||
    value.osStartIdentity.length === 0 ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length === 0 ||
    typeof value.commandLine !== "string" ||
    value.commandLine.length === 0
  ) {
    return null;
  }
  return {
    status: "present",
    pid: value.pid as number,
    bootIdentity: value.bootIdentity,
    osStartIdentity: value.osStartIdentity,
    executablePath: value.executablePath,
    commandLine: value.commandLine,
  };
}

function normalizeProcessIdentityPath(value: string, platform: "linux" | "win32"): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function sandboxCallbackBridgeProcessIdentityMismatch(
  expected: SandboxCallbackBridgeProcessIdentity,
  actual: SandboxCallbackBridgeProcessIdentity,
): string | null {
  if (expected.schema !== actual.schema) return "schema";
  if (expected.platform !== actual.platform) return "platform";
  if (expected.pid !== actual.pid) return "pid";
  if (expected.bootIdentity !== actual.bootIdentity) return "bootIdentity";
  if (expected.osStartIdentity !== actual.osStartIdentity) return "osStartIdentity";
  if (
    normalizeProcessIdentityPath(expected.executablePath, expected.platform) !==
    normalizeProcessIdentityPath(actual.executablePath, actual.platform)
  ) {
    return "executablePath";
  }
  if (expected.scriptMarker !== actual.scriptMarker) return "scriptMarker";
  if (expected.instanceNonce !== actual.instanceNonce) return "instanceNonce";
  return null;
}

function parseSandboxCallbackBridgeProcessIdentity(
  value: unknown,
): SandboxCallbackBridgeProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const identity = value as Record<string, unknown>;
  if (
    identity.schema !== SANDBOX_CALLBACK_BRIDGE_PROCESS_IDENTITY_SCHEMA ||
    (identity.platform !== "linux" && identity.platform !== "win32") ||
    !Number.isInteger(identity.pid) ||
    (identity.pid as number) <= 0 ||
    typeof identity.bootIdentity !== "string" ||
    identity.bootIdentity.length === 0 ||
    typeof identity.osStartIdentity !== "string" ||
    identity.osStartIdentity.length === 0 ||
    typeof identity.executablePath !== "string" ||
    identity.executablePath.length === 0 ||
    typeof identity.scriptMarker !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.scriptMarker) ||
    typeof identity.instanceNonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(identity.instanceNonce)
  ) {
    return null;
  }
  return identity as unknown as SandboxCallbackBridgeProcessIdentity;
}

function normalizeMethod(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "GET";
}

function normalizeTimeoutMs(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function buildRunnerFailureMessage(action: string, result: RunProcessResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout;
  if (result.timedOut) {
    return `${action} timed out${detail ? `: ${detail}` : ""}`;
  }
  return `${action} failed with exit code ${result.exitCode ?? "null"}${detail ? `: ${detail}` : ""}`;
}

async function runShell(
  runner: CommandManagedRuntimeRunner,
  cwd: string,
  script: string,
  timeoutMs: number,
  shellCommand: "bash" | "sh" = "sh",
  stdin?: string,
): Promise<RunProcessResult> {
  return await runner.execute({
    command: shellCommand,
    args: shellCommandArgs(script),
    cwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
    },
    timeoutMs,
    stdin,
  });
}

function requireSuccessfulResult(action: string, result: RunProcessResult): RunProcessResult {
  if (!result.timedOut && result.exitCode === 0) return result;
  throw new Error(buildRunnerFailureMessage(action, result));
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.stat(filePath).then(() => true).catch(() => false);
}

function buildRemotePidLockAcquireScript(lockDirExpr: string, timeoutMessage: string): string[] {
  return [
    "attempts=0",
    `while ! mkdir ${lockDirExpr} 2>/dev/null; do`,
    "  holder_pid=\"\"",
    `  if [ -s ${lockDirExpr}/pid ]; then`,
    `    holder_pid="$(cat ${lockDirExpr}/pid 2>/dev/null || true)"`,
    "  fi",
    "  if [ -n \"$holder_pid\" ] && ! kill -0 \"$holder_pid\" 2>/dev/null; then",
    `    rm -rf ${lockDirExpr}`,
    "    continue",
    "  fi",
    "  attempts=$((attempts + 1))",
    "  if [ \"$attempts\" -ge 600 ]; then",
    `    echo ${shellQuote(timeoutMessage)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 0.05",
    "done",
    `printf '%s\\n' "$$" > ${lockDirExpr}/pid`,
  ];
}

function buildRemotePidLockCleanupScript(lockDirExpr: string, cleanupLines: string[]): string[] {
  return [
    "cleanup() {",
    ...cleanupLines.map((line) => `  ${line}`),
    `  rm -rf ${lockDirExpr}`,
    "}",
    "trap cleanup EXIT INT TERM",
  ];
}

export function createSandboxCallbackBridgeToken(bytes = DEFAULT_BRIDGE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function authorizeSandboxCallbackBridgeRequestWithRoutes(
  request: Pick<SandboxCallbackBridgeRequest, "method" | "path">,
  routes: readonly SandboxCallbackBridgeRouteRule[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
): string | null {
  const method = normalizeMethod(request.method);
  return routes.some((route) => route.method === method && route.path.test(request.path))
    ? null
    : `Route not allowed: ${method} ${request.path}`;
}

export function sanitizeSandboxCallbackBridgeHeaders(
  headers: Record<string, string>,
  allowlist: readonly string[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
): Record<string, string> {
  const allowed = new Set(allowlist.map((header) => header.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

export function sandboxCallbackBridgeDirectories(rootDir: string): SandboxCallbackBridgeDirectories {
  return {
    rootDir,
    requestsDir: joinPortablePath(rootDir, "requests"),
    responsesDir: joinPortablePath(rootDir, "responses"),
    logsDir: joinPortablePath(rootDir, "logs"),
    readyFile: joinPortablePath(rootDir, "ready.json"),
    pidFile: joinPortablePath(rootDir, "server.pid"),
    cancelFile: joinPortablePath(rootDir, "startup-cancel.json"),
    cancelAckFile: joinPortablePath(rootDir, "startup-cancelled.json"),
    launchFile: joinPortablePath(rootDir, "startup-launch.json"),
    dispatchClaimFile: joinPortablePath(rootDir, "startup-dispatch.claim"),
    logFile: joinPortablePath(rootDir, "logs", "bridge.log"),
  };
}

export function buildSandboxCallbackBridgeEnv(input: {
  queueDir: string;
  bridgeToken: string;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Record<string, string> {
  return {
    PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    PAPERCLIP_BRIDGE_QUEUE_DIR: input.queueDir,
    PAPERCLIP_BRIDGE_TOKEN: input.bridgeToken,
    PAPERCLIP_BRIDGE_HOST: input.host?.trim() || "127.0.0.1",
    PAPERCLIP_BRIDGE_PORT: String(input.port && input.port > 0 ? Math.trunc(input.port) : 0),
    PAPERCLIP_BRIDGE_POLL_INTERVAL_MS: String(
      normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS),
    ),
    PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: String(
      normalizeTimeoutMs(input.responseTimeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS),
    ),
    PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH: String(
      normalizeTimeoutMs(input.maxQueueDepth, DEFAULT_BRIDGE_MAX_QUEUE_DEPTH),
    ),
    PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(
      normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES),
    ),
  };
}

export async function createSandboxCallbackBridgeAsset(): Promise<SandboxCallbackBridgeAsset> {
  const privateDirectory = await createPrivateExecutableAssetDirectory({
    prefix: "paperclip-bridge-asset-",
  });
  const localDir = privateDirectory.directoryPath;
  const entrypoint = path.join(localDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  try {
    await fs.writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
    await privateDirectory.assertIntegrity();
  } catch (error) {
    try {
      await privateDirectory.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to initialize and clean up the private sandbox callback bridge asset.",
      );
    }
    throw error;
  }
  return {
    localDir,
    entrypoint,
    cleanup: privateDirectory.cleanup,
  };
}

export function createFileSystemSandboxCallbackBridgeQueueClient(): SandboxCallbackBridgeQueueClient {
  return {
    makeDir: async (remotePath) => {
      await fs.mkdir(remotePath, { recursive: true });
    },
    listJsonFiles: async (remotePath) => {
      const entries = await fs.readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => await fs.readFile(remotePath, "utf8"),
    writeTextFile: async (remotePath, body) => {
      await fs.mkdir(dirnamePortablePath(remotePath), { recursive: true });
      await fs.writeFile(remotePath, body, "utf8");
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = dirnamePortablePath(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const lockPidFile = `${lockDir}/pid`;
      if (options.requestPath) {
        const requestExists = await pathExists(options.requestPath);
        if (!requestExists) {
          return { wrote: false };
        }
      }
      await fs.mkdir(responseDir, { recursive: true });
      // PID-liveness mkdir-mutex: mirrors the shell-based bridge mutex so a
      // crashed holder (SIGKILL / OOM) doesn't deadlock subsequent writers
      // for the full timeout window.
      let attempts = 0;
      while (true) {
        try {
          await fs.mkdir(lockDir);
          await fs.writeFile(lockPidFile, `${process.pid}\n`, "utf8");
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "EEXIST") {
            throw error;
          }
          let holderPid: number | null = null;
          try {
            const raw = await fs.readFile(lockPidFile, "utf8");
            const parsed = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) holderPid = parsed;
          } catch {
            // pid file missing or unreadable — treat as stale lock
          }
          let holderAlive = false;
          if (holderPid !== null) {
            try {
              process.kill(holderPid, 0);
              holderAlive = true;
            } catch {
              holderAlive = false;
            }
          }
          if (!holderAlive) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
          attempts += 1;
          if (attempts >= 600) {
            throw new Error("Timed out acquiring sandbox callback bridge response lock.");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      try {
        if (options.requestPath) {
          const requestExists = await pathExists(options.requestPath);
          if (!requestExists) {
            return { wrote: false };
          }
        }
        const responseExists = await pathExists(responsePath);
        if (responseExists) {
          return { wrote: false };
        }
        await fs.writeFile(tempPath, body, "utf8");
        await fs.rename(tempPath, responsePath);
        return { wrote: true };
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    rename: async (fromPath, toPath) => {
      await fs.mkdir(dirnamePortablePath(toPath), { recursive: true });
      await fs.rename(fromPath, toPath);
    },
    remove: async (remotePath) => {
      await fs.rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function createCommandManagedSandboxCallbackBridgeQueueClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): SandboxCallbackBridgeQueueClient {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runChecked = async (action: string, script: string) =>
    requireSuccessfulResult(action, await runShell(input.runner, input.remoteCwd, script, timeoutMs, shellCommand));
  const runCheckedWithStdin = async (action: string, script: string, stdin: string) =>
    requireSuccessfulResult(
      action,
      await runShell(input.runner, input.remoteCwd, script, timeoutMs, shellCommand, stdin),
    );

  return {
    makeDir: async (remotePath) => {
      await runChecked(`mkdir ${remotePath}`, `mkdir -p ${shellQuotePath(remotePath)}`);
    },
    listJsonFiles: async (remotePath) => {
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          `if [ -d ${shellQuotePath(remotePath)} ]; then`,
          `  for file in ${shellQuotePath(remotePath)}/*.json; do`,
          `    [ -f "$file" ] || continue`,
          "    basename \"$file\"",
          "  done",
          "fi",
        ].join("\n"),
        timeoutMs,
        shellCommand,
      );
      requireSuccessfulResult(`list ${remotePath}`, result);
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => {
      const result = await runChecked(`read ${remotePath}`, `base64 < ${shellQuotePath(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
    },
    writeTextFile: async (remotePath, body) => {
      const remoteDir = dirnamePortablePath(remotePath);
      const tempPath = `${remotePath}.paperclip-upload.b64`;
      const decodedTempPath = `${remotePath}.paperclip-upload.tmp`;
      await runChecked(
        `prepare upload ${remotePath}`,
        `mkdir -p ${shellQuotePath(remoteDir)} && ` +
          `rm -f ${shellQuotePath(tempPath)} ${shellQuotePath(decodedTempPath)} && ` +
          `: > ${shellQuotePath(tempPath)}`,
      );
      const base64Body = toBuffer(Buffer.from(body, "utf8")).toString("base64");
      await runCheckedWithStdin(
        `upload ${remotePath}`,
        `cat > ${shellQuotePath(tempPath)}`,
        base64Body,
      );
      await runChecked(
        `finalize upload ${remotePath}`,
        `base64 -d < ${shellQuotePath(tempPath)} > ${shellQuotePath(decodedTempPath)} && ` +
          `mv -f ${shellQuotePath(decodedTempPath)} ${shellQuotePath(remotePath)} && ` +
          `rm -f ${shellQuotePath(tempPath)}`,
      );
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = dirnamePortablePath(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const requestPath = options.requestPath?.trim() || "";
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          "set -eu",
          `response_dir=${shellQuotePath(responseDir)}`,
          `response_path=${shellQuotePath(responsePath)}`,
          `temp_path=${shellQuotePath(tempPath)}`,
          `lock_dir=${shellQuotePath(lockDir)}`,
          `request_path=${shellQuotePath(requestPath)}`,
          "mkdir -p \"$response_dir\"",
          ...buildRemotePidLockAcquireScript("\"$lock_dir\"", "Timed out acquiring sandbox callback bridge response lock."),
          ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
            "rm -f \"$temp_path\"",
          ]),
          "if [ -n \"$request_path\" ] && [ ! -f \"$request_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "if [ -f \"$response_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "cat > \"$temp_path\"",
          "mv \"$temp_path\" \"$response_path\"",
          "printf '{\"wrote\":true}\\n'",
        ].join("\n"),
        timeoutMs,
        shellCommand,
        body,
      );
      requireSuccessfulResult(`write bridge response ${responsePath}`, result);
      try {
        return {
          wrote: JSON.parse(result.stdout.trim())?.wrote === true,
        };
      } catch (error) {
        throw new Error(
          `Sandbox callback bridge response write wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    rename: async (fromPath, toPath) => {
      await runChecked(
        `rename ${fromPath}`,
        `mkdir -p ${shellQuotePath(dirnamePortablePath(toPath))} && mv ${shellQuotePath(fromPath)} ${shellQuotePath(toPath)}`,
      );
    },
    remove: async (remotePath) => {
      await runChecked(`remove ${remotePath}`, `rm -rf ${shellQuotePath(remotePath)}`);
    },
  };
}

async function writeBridgeResponse(
  client: SandboxCallbackBridgeQueueClient,
  requestPath: string,
  responsePath: string,
  response: SandboxCallbackBridgeResponse,
  options: { requireRequestPath?: boolean } = {},
) {
  const body = `${JSON.stringify(response)}\n`;
  if (client.writeResponseFile) {
    await client.writeResponseFile(responsePath, body, options.requireRequestPath === false ? {} : { requestPath });
    return;
  }
  const tempPath = `${responsePath}.tmp`;
  await client.writeTextFile(tempPath, body);
  await client.rename(tempPath, responsePath);
}

export async function startSandboxCallbackBridgeWorker(input: {
  client: SandboxCallbackBridgeQueueClient;
  queueDir: string;
  pollIntervalMs?: number | null;
  authorizeRequest?: (request: SandboxCallbackBridgeRequest) => string | null | Promise<string | null>;
  handleRequest: (request: SandboxCallbackBridgeRequest) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }>;
  maxBodyBytes?: number | null;
}): Promise<SandboxCallbackBridgeWorkerHandle> {
  const pollIntervalMs = normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS);
  const maxBodyBytes = normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  await input.client.makeDir(directories.rootDir);
  await input.client.makeDir(directories.requestsDir);
  await input.client.makeDir(directories.responsesDir);
  await input.client.makeDir(directories.logsDir);

  let stopping = false;
  let inFlight = 0;
  let settled = false;
  let stopDeadline = Number.POSITIVE_INFINITY;
  let settleResolve: (() => void) | null = null;
  const settledPromise = new Promise<void>((resolve) => {
    settleResolve = resolve;
  });
  const authorizeRequest = input.authorizeRequest ??
    ((request: SandboxCallbackBridgeRequest) => authorizeSandboxCallbackBridgeRequestWithRoutes(request));
  const buildWorkerFailureMessage = (error: unknown) =>
    `Sandbox callback bridge worker failed: ${error instanceof Error ? error.message : String(error)}`;

  const processRequestFile = async (fileName: string) => {
    const requestPath = joinPortablePath(directories.requestsDir, fileName);
    const responsePath = joinPortablePath(directories.responsesDir, fileName);
    const raw = await input.client.readTextFile(requestPath);
    let request: SandboxCallbackBridgeRequest;
    try {
      request = JSON.parse(raw) as SandboxCallbackBridgeRequest;
    } catch {
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: requestId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Invalid bridge request payload." }),
        completedAt: new Date().toISOString(),
      });
      await input.client.remove(requestPath);
      return;
    }

    const denialReason = await authorizeRequest(request);
    if (denialReason) {
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: denialReason }),
        completedAt: new Date().toISOString(),
      });
      await input.client.remove(requestPath);
      return;
    }

    try {
      const result = await input.handleRequest(request);
      const responseBody = result.body ?? "";
      if (Buffer.byteLength(responseBody, "utf8") > maxBodyBytes) {
        throw new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
      }
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: result.status,
        headers: result.headers ?? {},
        body: responseBody,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        `[paperclip] sandbox callback bridge handler failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        completedAt: new Date().toISOString(),
      });
    } finally {
      await input.client.remove(requestPath);
    }
  };

  const failPendingRequests = async (message: string) => {
    const fileNames = await input.client.listJsonFiles(directories.requestsDir).catch(() => []);
    for (const fileName of fileNames) {
      const requestPath = joinPortablePath(directories.requestsDir, fileName);
      const responsePath = joinPortablePath(directories.responsesDir, fileName);
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      try {
        const raw = await input.client.readTextFile(requestPath);
        const parsed = JSON.parse(raw) as Partial<SandboxCallbackBridgeRequest>;
        await input.client.remove(requestPath).catch(() => undefined);
        await writeBridgeResponse(input.client, requestPath, responsePath, {
          id: typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : requestId,
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: message }),
          completedAt: new Date().toISOString(),
        }, {
          requireRequestPath: false,
        });
      } catch (error) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to abort pending request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await input.client.remove(requestPath).catch(() => undefined);
      }
    }
  };

  const loop = (async () => {
    try {
      while (true) {
        const fileNames = await input.client.listJsonFiles(directories.requestsDir);
        if (fileNames.length === 0) {
          if (stopping) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        for (const fileName of fileNames) {
          if (stopping && Date.now() >= stopDeadline) break;
          inFlight += 1;
          try {
            await processRequestFile(fileName);
          } finally {
            inFlight -= 1;
          }
        }
        if (stopping && Date.now() >= stopDeadline) {
          break;
        }
      }
    } catch (error) {
      const message = buildWorkerFailureMessage(error);
      console.warn(`[paperclip] ${message}`);
      try {
        await failPendingRequests(message);
      } catch (failPendingError) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to abort queued requests after worker failure: ${failPendingError instanceof Error ? failPendingError.message : String(failPendingError)}`,
        );
      }
    } finally {
      settled = true;
      if (settleResolve) {
        settleResolve();
      }
    }
  })();

  void loop;

  return {
    stop: async (options = {}) => {
      stopping = true;
      const drainMs = normalizeTimeoutMs(options.drainTimeoutMs, DEFAULT_BRIDGE_STOP_TIMEOUT_MS);
      stopDeadline = Date.now() + drainMs;
      if (!settled) {
        await Promise.race([
          settledPromise,
          new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
        ]);
      }
      await failPendingRequests("Bridge worker stopped before request could be handled.");
    },
  };
}

/**
 * Content-hash-skip write of a Paperclip-authored text file into the sandbox, in
 * a SINGLE remote exec. The body's sha256 is computed on the host; the one shell
 * round-trip skips the write entirely when the remote file already hashes to the
 * same value (warm start — 0 write execs), otherwise it uploads (base64 over
 * stdin), verifies the decoded bytes, and atomically renames into place. A
 * PID-liveness lock serializes concurrent writers to the same path and the
 * verify step guards against a torn upload.
 *
 * Fail loudly: a non-zero remote exit (surfaced by `requireSuccessfulResult`) or
 * malformed result JSON throws rather than silently re-uploading and masking a
 * failed check. The only intentional degradation is when the remote has neither
 * `sha256sum` nor `shasum` — then the skip cannot be proven and we conservatively
 * re-upload (and the post-upload verify is best-effort, as noted inline).
 */
export async function syncRemoteTextFileWithHashSkip(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  remoteDir: string;
  remotePath: string;
  body: string;
  // Human-readable noun phrase used in fail-loud messages, e.g.
  // "Sandbox callback bridge entrypoint" / "Process session remote script".
  label: string;
  // Short action label for `requireSuccessfulResult`, e.g.
  // "sync sandbox callback bridge entrypoint".
  action: string;
  lockDir: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ uploaded: boolean; sha256: string }> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const remotePartial = `${input.remotePath}.partial`;
  const remoteUploadPath = `${input.remotePath}.paperclip-upload.b64`;
  const base64Body = toBuffer(Buffer.from(input.body, "utf8")).toString("base64");
  const sha256 = createHash("sha256").update(input.body, "utf8").digest("hex");

  const syncResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "set -eu",
      `remote_dir=${shellQuotePath(input.remoteDir)}`,
      `remote_path=${shellQuotePath(input.remotePath)}`,
      `remote_partial=${shellQuotePath(remotePartial)}`,
      `remote_upload=${shellQuotePath(remoteUploadPath)}`,
      `lock_dir=${shellQuotePath(input.lockDir)}`,
      `expected_sha=${shellQuote(sha256)}`,
      "hash_file() {",
      "  if command -v sha256sum >/dev/null 2>&1; then",
      "    sha256sum \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  if command -v shasum >/dev/null 2>&1; then",
      "    shasum -a 256 \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  return 127",
      "}",
      "mkdir -p \"$remote_dir\"",
      ...buildRemotePidLockAcquireScript("\"$lock_dir\"", `Timed out acquiring ${input.label} upload lock.`),
      ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
        "rm -f \"$remote_upload\" \"$remote_partial\"",
      ]),
      "current_sha=\"\"",
      "if [ -f \"$remote_path\" ]; then",
      "  current_sha=\"$(hash_file \"$remote_path\" 2>/dev/null)\" || current_sha=\"\"",
      "fi",
      "if [ -n \"$current_sha\" ] && [ \"$current_sha\" = \"$expected_sha\" ]; then",
      "  printf '{\"uploaded\":false}\\n'",
      "  exit 0",
      "fi",
      "rm -f \"$remote_upload\" \"$remote_partial\"",
      "cat > \"$remote_upload\"",
      "base64 -d < \"$remote_upload\" > \"$remote_partial\"",
      // Verify upload integrity. If neither sha256sum nor shasum is on PATH
      // (minimal Alpine/scratch images), surface the missing-tool error
      // instead of a misleading "sha mismatch" — the verify step is then
      // best-effort and we trust base64-decode + atomic rename below.
      "if partial_sha=\"$(hash_file \"$remote_partial\" 2>/dev/null)\"; then",
      "  if [ \"$partial_sha\" != \"$expected_sha\" ]; then",
      `    echo ${shellQuote(`${input.label} upload sha mismatch.`)} >&2`,
      "    exit 1",
      "  fi",
      "else",
      `  echo ${shellQuote(`${input.label} sha verify skipped: no sha256sum/shasum on remote.`)} >&2`,
      "fi",
      "mv \"$remote_partial\" \"$remote_path\"",
      "printf '{\"uploaded\":true}\\n'",
    ].join("\n"),
    timeoutMs,
    shellCommand,
    base64Body,
  );
  requireSuccessfulResult(input.action, syncResult);

  let uploaded = false;
  try {
    uploaded = JSON.parse(syncResult.stdout.trim())?.uploaded === true;
  } catch (error) {
    throw new Error(
      `${input.label} sync wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { uploaded, sha256 };
}

export async function syncSandboxCallbackBridgeEntrypoint(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  bridgeAsset: SandboxCallbackBridgeAsset;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ remoteEntrypoint: string; sha256: string; uploaded: boolean }> {
  const remoteEntrypoint = joinPortablePath(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  const entrypointSource = await fs.readFile(input.bridgeAsset.entrypoint, "utf8");
  const { uploaded, sha256 } = await syncRemoteTextFileWithHashSkip({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    remoteDir: input.assetRemoteDir,
    remotePath: remoteEntrypoint,
    body: entrypointSource,
    label: "Sandbox callback bridge entrypoint",
    action: "sync sandbox callback bridge entrypoint",
    lockDir: joinPortablePath(input.assetRemoteDir, ".paperclip-bridge-upload.lock"),
    timeoutMs: input.timeoutMs,
    shellCommand: input.shellCommand,
  });

  return {
    remoteEntrypoint,
    sha256,
    uploaded,
  };
}

/**
 * Self-contained source shared by the remote bridge and its stop verifier.
 * It intentionally probes only Linux /proc and Windows CIM; unsupported or
 * incomplete inspection is an ambiguous result and therefore cannot signal.
 */
function getSandboxCallbackBridgeProcessProbeSource(): string {
  return `
const callbackIdentitySchema = "${SANDBOX_CALLBACK_BRIDGE_PROCESS_IDENTITY_SCHEMA}";
const callbackNonceArg = "${SANDBOX_CALLBACK_BRIDGE_NONCE_ARG}";
const callbackScriptMarkerArg = "${SANDBOX_CALLBACK_BRIDGE_SCRIPT_MARKER_ARG}";

function parseLinuxProcStatStartIdentitySource(stat) {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fieldsFromState = stat.slice(commEnd + 1).trim().split(/\\s+/);
  const startTime = fieldsFromState[19];
  return typeof startTime === "string" && /^\\d+$/.test(startTime) ? startTime : null;
}

function parseWindowsCimIdentitySource(raw) {
  let value;
  try { value = JSON.parse(String(raw).trim()); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  if (value.status === "absent") return { status: "absent" };
  if (
    value.status !== "present" || !Number.isInteger(value.pid) || value.pid <= 0 ||
    typeof value.bootIdentity !== "string" || !value.bootIdentity ||
    typeof value.osStartIdentity !== "string" || !value.osStartIdentity ||
    typeof value.executablePath !== "string" || !value.executablePath ||
    typeof value.commandLine !== "string" || !value.commandLine
  ) return null;
  return value;
}

function extractUniqueArrayFlag(args, prefix) {
  const values = args.filter((arg) => typeof arg === "string" && arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  return values.length === 1 && values[0] ? values[0] : null;
}

function extractUniqueCommandLineFlag(commandLine, prefix) {
  const escaped = prefix.replace(/[.*+?^$()|[\\]\\\\]/g, "\\\\$&");
  const matches = [...commandLine.matchAll(new RegExp("(?:^|[\\\\s\\\"])(?:\\\")?" + escaped + "([^\\\\s\\\"]+)", "gi"))].map((match) => match[1]);
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function readWindowsCimIdentity(pid) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"',
    "if($null -eq $p){[pscustomobject]@{status='absent'}|ConvertTo-Json -Compress;exit 0}",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$boot=([DateTime]$os.LastBootUpTime).ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "$start=([DateTime]$p.CreationDate).ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "[pscustomobject]@{status='present';pid=[int]$p.ProcessId;bootIdentity=$boot;osStartIdentity=$start;executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress"
  ].join(";");
  let lastError = null;
  for (const command of ["pwsh", "powershell.exe"]) {
    try {
      const raw = execFileSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = parseWindowsCimIdentitySource(raw);
      if (!parsed) return { status: "unavailable", reason: "Windows CIM returned malformed process identity." };
      return parsed;
    } catch (error) {
      lastError = error;
      if (!error || error.code !== "ENOENT") break;
    }
  }
  return { status: "unavailable", reason: "Windows CIM process identity probe failed: " + (lastError && lastError.message ? lastError.message : String(lastError)) };
}

function normalizeCallbackIdentityPath(value, platform) {
  const normalized = String(value).replace(/\\\\/g, "/").replace(/\\\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function probeCallbackProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unavailable", reason: "Process id is invalid." };
  if (process.platform === "linux") {
    const procDir = "/proc/" + pid;
    if (!fsSync.existsSync(procDir)) return { status: "absent" };
    try {
      const bootIdentity = fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const osStartIdentity = parseLinuxProcStatStartIdentitySource(fsSync.readFileSync(procDir + "/stat", "utf8"));
      const executablePath = fsSync.readlinkSync(procDir + "/exe");
      const args = fsSync.readFileSync(procDir + "/cmdline").toString("utf8").split("\\0").filter(Boolean);
      const scriptMarker = extractUniqueArrayFlag(args, callbackScriptMarkerArg);
      const instanceNonce = extractUniqueArrayFlag(args, callbackNonceArg);
      if (!bootIdentity || !osStartIdentity || !executablePath || !scriptMarker || !instanceNonce) {
        return { status: "unavailable", reason: "Linux /proc process identity was incomplete or ambiguous." };
      }
      return { status: "present", identity: { schema: callbackIdentitySchema, platform: "linux", pid, bootIdentity, osStartIdentity, executablePath, scriptMarker, instanceNonce } };
    } catch (error) {
      if (error && error.code === "ENOENT" && !fsSync.existsSync(procDir)) return { status: "absent" };
      return { status: "unavailable", reason: "Linux /proc process identity probe failed: " + (error && error.message ? error.message : String(error)) };
    }
  }
  if (process.platform === "win32") {
    const cim = readWindowsCimIdentity(pid);
    if (cim.status !== "present") return cim;
    const scriptMarker = extractUniqueCommandLineFlag(cim.commandLine, callbackScriptMarkerArg);
    const instanceNonce = extractUniqueCommandLineFlag(cim.commandLine, callbackNonceArg);
    if (!scriptMarker || !instanceNonce) return { status: "unavailable", reason: "Windows CIM command line identity was incomplete or ambiguous." };
    return { status: "present", identity: { schema: callbackIdentitySchema, platform: "win32", pid, bootIdentity: cim.bootIdentity, osStartIdentity: cim.osStartIdentity, executablePath: cim.executablePath, scriptMarker, instanceNonce } };
  }
  return { status: "unavailable", reason: "Unsupported process identity platform: " + process.platform };
}

function callbackProcessIdentityMismatch(expected, actual) {
  if (expected.schema !== actual.schema) return "schema";
  if (expected.platform !== actual.platform) return "platform";
  if (expected.pid !== actual.pid) return "pid";
  if (expected.bootIdentity !== actual.bootIdentity) return "bootIdentity";
  if (expected.osStartIdentity !== actual.osStartIdentity) return "osStartIdentity";
  if (normalizeCallbackIdentityPath(expected.executablePath, expected.platform) !== normalizeCallbackIdentityPath(actual.executablePath, actual.platform)) return "executablePath";
  if (expected.scriptMarker !== actual.scriptMarker) return "scriptMarker";
  if (expected.instanceNonce !== actual.instanceNonce) return "instanceNonce";
  return null;
}
`;
}

/**
 * Atomic file evidence with explicit file flushes on every supported Node 20
 * runtime. POSIX also flushes the parent directory after rename. Node cannot
 * open Windows directories for fsync, so Windows power-loss directory-entry
 * durability remains an explicit production-adoption limitation.
 */
function getSandboxCallbackBridgeDurableEvidenceSource(): string {
  return `
function writeAtomicCallbackEvidence(file, body) {
  const tempFile = file + ".tmp-" + process.pid;
  let descriptor = fsSync.openSync(tempFile, "w", 0o600);
  try {
    fsSync.writeFileSync(descriptor, body, { encoding: "utf8" });
    fsSync.fsyncSync(descriptor);
  } finally {
    fsSync.closeSync(descriptor);
  }
  fsSync.renameSync(tempFile, file);
  descriptor = fsSync.openSync(file, "r+");
  try { fsSync.fsyncSync(descriptor); } finally { fsSync.closeSync(descriptor); }
  if (process.platform !== "win32") {
    descriptor = fsSync.openSync(path.dirname(file), "r");
    try { fsSync.fsyncSync(descriptor); } finally { fsSync.closeSync(descriptor); }
  }
}
`;
}

async function persistSandboxCallbackBridgeLaunchIntent(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  nodeCommand: string;
  directories: SandboxCallbackBridgeDirectories;
  instanceNonce: string;
  scriptMarker: string;
  timeoutMs: number;
}): Promise<void> {
  const launchIntent = {
    schema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
    instanceNonce: input.instanceNonce,
    scriptMarker: input.scriptMarker,
    state: "intent",
    createdAt: new Date().toISOString(),
  };
  const source = [
    'const fs = require("node:fs");',
    "const fsSync = fs;",
    'const path = require("node:path");',
    getSandboxCallbackBridgeDurableEvidenceSource(),
    "const input = JSON.parse(process.argv[1]);",
    "const read = (file) => { if (!fs.existsSync(file)) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Existing callback launch evidence is malformed: ' + file); } };",
    "fs.mkdirSync(path.dirname(input.launchFile), { recursive: true, mode: 0o700 });",
    "try { fs.chmodSync(path.dirname(input.launchFile), 0o700); } catch {}",
    "const existingLaunch = read(input.launchFile);",
    "if (existingLaunch && (existingLaunch.schema !== input.launchIntent.schema || existingLaunch.instanceNonce !== input.launchIntent.instanceNonce || existingLaunch.scriptMarker !== input.launchIntent.scriptMarker)) throw new Error('Callback launch evidence belongs to another instance or script marker.');",
    "const existingCancel = read(input.cancelFile);",
    "if (existingCancel && (existingCancel.schema !== input.cancelSchema || existingCancel.instanceNonce !== input.launchIntent.instanceNonce)) throw new Error('Callback cancellation tombstone belongs to another instance.');",
    "const existingAck = read(input.cancelAckFile);",
    "if (existingAck && (existingAck.schema !== input.cancelAckSchema || existingAck.instanceNonce !== input.launchIntent.instanceNonce)) throw new Error('Callback cancellation acknowledgement belongs to another instance.');",
    "const existingClaim = read(path.join(input.dispatchClaimFile, 'owner.json'));",
    "if (fs.existsSync(input.dispatchClaimFile) && !existingClaim) throw new Error('Callback dispatch claim directory is missing its owner receipt.');",
    "if (existingClaim && (existingClaim.schema !== input.dispatchClaimSchema || existingClaim.instanceNonce !== input.launchIntent.instanceNonce)) throw new Error('Callback dispatch claim belongs to another instance.');",
    "if (!existingLaunch) {",
    "  writeAtomicCallbackEvidence(input.launchFile, JSON.stringify(input.launchIntent) + '\\n');",
    "}",
  ].join("\n");
  const result = await input.runner.execute({
    command: input.nodeCommand,
    args: [
      "-e",
      source,
      JSON.stringify({
        launchFile: input.directories.launchFile,
        cancelFile: input.directories.cancelFile,
        cancelAckFile: input.directories.cancelAckFile,
        dispatchClaimFile: input.directories.dispatchClaimFile,
        cancelSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
        cancelAckSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
        dispatchClaimSchema: SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA,
        launchIntent,
      }),
    ],
    cwd: input.remoteCwd,
    env: { [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE },
    timeoutMs: input.timeoutMs,
  });
  requireSuccessfulResult("persist sandbox callback bridge pre-dispatch launch intent", result);
}

async function cancelStartedSandboxCallbackBridge(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  nodeCommand: string;
  directories: SandboxCallbackBridgeDirectories;
  instanceNonce: string;
  scriptMarker: string;
  acceptedProcessIdentity: SandboxCallbackBridgeProcessIdentity | null;
  timeoutMs: number;
}): Promise<"cancelled"> {
  const cancellation = {
    schema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
    instanceNonce: input.instanceNonce,
    requestedAt: new Date().toISOString(),
  };
  const publishSource = [
    'const fs = require("node:fs");',
    "const fsSync = fs;",
    'const path = require("node:path");',
    getSandboxCallbackBridgeDurableEvidenceSource(),
    "const input = JSON.parse(process.argv[1]);",
    "fs.mkdirSync(path.dirname(input.cancelFile), { recursive: true, mode: 0o700 });",
    "try { fs.chmodSync(path.dirname(input.cancelFile), 0o700); } catch {}",
    "if (fs.existsSync(input.cancelAckFile)) {",
    "  let acknowledgement; try { acknowledgement = JSON.parse(fs.readFileSync(input.cancelAckFile, 'utf8')); } catch { throw new Error('Existing callback cancellation acknowledgement is malformed.'); }",
    "  if (acknowledgement.schema !== input.cancelAckSchema || acknowledgement.instanceNonce !== input.cancellation.instanceNonce) throw new Error('Callback cancellation acknowledgement belongs to another launch instance.');",
    "  process.exit(0);",
    "}",
    "if (fs.existsSync(input.cancelFile)) {",
    "  let existing; try { existing = JSON.parse(fs.readFileSync(input.cancelFile, 'utf8')); } catch { throw new Error('Existing callback cancellation tombstone is malformed.'); }",
    "  if (existing.schema !== input.cancellation.schema || existing.instanceNonce !== input.cancellation.instanceNonce) throw new Error('Callback cancellation tombstone belongs to another launch instance.');",
    "  process.exit(0);",
    "}",
    "writeAtomicCallbackEvidence(input.cancelFile, JSON.stringify(input.cancellation) + '\\n');",
  ].join("\n");
  const publishResult = await input.runner.execute({
    command: input.nodeCommand,
    args: [
      "-e",
      publishSource,
      JSON.stringify({
        cancelFile: input.directories.cancelFile,
        cancelAckFile: input.directories.cancelAckFile,
        cancelAckSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
        cancellation,
      }),
    ],
    cwd: input.remoteCwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
    },
    timeoutMs: input.timeoutMs,
  });
  requireSuccessfulResult("publish sandbox callback bridge startup cancellation", publishResult);

  const waitSource = [
    'const fs = require("node:fs");',
    'const fsSync = require("node:fs");',
    'const path = require("node:path");',
    'const { execFileSync } = require("node:child_process");',
    getSandboxCallbackBridgeDurableEvidenceSource(),
    getSandboxCallbackBridgeProcessProbeSource(),
    "const input = JSON.parse(process.argv[1]);",
    "const deadline = Date.now() + input.waitTimeoutMs;",
    "const readJson = (file, label) => { if (!fs.existsSync(file)) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(label + ' evidence is malformed.'); } };",
    "const validateIdentity = (identity, label) => {",
    "  if (!identity || typeof identity !== 'object' || identity.schema !== callbackIdentitySchema || identity.instanceNonce !== input.instanceNonce || identity.scriptMarker !== input.scriptMarker || !Number.isInteger(identity.pid) || identity.pid <= 0) throw new Error(label + ' carried an invalid process birth identity.');",
    "  if (input.acceptedProcessIdentity) { const mismatch = callbackProcessIdentityMismatch(input.acceptedProcessIdentity, identity); if (mismatch) throw new Error(label + ' changed accepted process identity field: ' + mismatch); }",
    "  return identity;",
    "};",
    "const validateExactEvidence = (expected) => {",
    "  if (fs.existsSync(input.dispatchClaimFile)) {",
    "    const claim = readJson(path.join(input.dispatchClaimFile, 'owner.json'), 'Callback dispatch claim');",
    "    if (!claim || claim.schema !== input.dispatchClaimSchema || claim.instanceNonce !== input.instanceNonce) throw new Error('Callback dispatch claim belongs to another instance during cleanup.');",
    "  }",
    "  const launch = readJson(input.launchFile, 'Callback launch');",
    "  if (launch && (launch.schema !== input.launchSchema || launch.instanceNonce !== input.instanceNonce || launch.scriptMarker !== input.scriptMarker)) throw new Error('Callback launch evidence belongs to another instance or script marker during cleanup.');",
    "  if (launch && expected) {",
    "    if (launch.state !== 'accepted' || launch.pid !== expected.pid || !launch.processIdentity) throw new Error('Callback launch evidence did not preserve the accepted process identity during cleanup.');",
    "    const launchMismatch = callbackProcessIdentityMismatch(expected, launch.processIdentity);",
    "    if (launchMismatch) throw new Error('Callback launch evidence changed accepted process identity field during cleanup: ' + launchMismatch);",
    "  }",
    "  if (launch?.state === 'accepted' && !expected) throw new Error('Prelaunch cleanup found accepted process evidence.');",
    "  const cancellation = readJson(input.cancelFile, 'Callback cancellation');",
    "  if (cancellation && (cancellation.schema !== input.cancelSchema || cancellation.instanceNonce !== input.instanceNonce)) throw new Error('Callback cancellation evidence belongs to another instance during cleanup.');",
    "  const readiness = readJson(input.readyFile, 'Callback readiness');",
    "  if (readiness && readiness.processIdentity?.instanceNonce !== input.instanceNonce) throw new Error('Callback readiness evidence belongs to another instance during cleanup.');",
    "  if (readiness && expected) {",
    "    if (readiness.pid !== expected.pid || !readiness.processIdentity) throw new Error('Callback readiness evidence did not preserve the accepted process identity during cleanup.');",
    "    const readinessMismatch = callbackProcessIdentityMismatch(expected, readiness.processIdentity);",
    "    if (readinessMismatch) throw new Error('Callback readiness evidence changed accepted process identity field during cleanup: ' + readinessMismatch);",
    "  }",
    "  if (readiness && !expected) throw new Error('Prelaunch cleanup found readiness process evidence.');",
    "  if (fs.existsSync(input.pidFile)) {",
    "    const pidReceipt = Number(fs.readFileSync(input.pidFile, 'utf8').trim());",
    "    if (!expected || !Number.isInteger(pidReceipt) || pidReceipt !== expected.pid) throw new Error('Callback pid evidence was unavailable or mismatched during cleanup.');",
    "  }",
    "};",
    "const deleteExactEvidence = () => {",
    "  for (const candidate of [input.readyFile, input.pidFile, input.cancelFile, input.launchFile]) fs.rmSync(candidate, { force: true });",
    "  fs.rmSync(input.dispatchClaimFile, { recursive: true, force: true });",
    "};",
    "const processBirthIsGone = (expected) => {",
    "  const probe = probeCallbackProcessIdentity(expected.pid);",
    "  if (probe.status === 'unavailable') throw new Error(probe.reason || 'Sandbox callback bridge process absence probe was unavailable.');",
    "  return probe.status === 'absent' || callbackProcessIdentityMismatch(expected, probe.identity) !== null;",
    "};",
    "const writeHostReconciledAck = (expected) => {",
    "  const acknowledgement = { schema: input.ackSchema, instanceNonce: input.instanceNonce, cancelledAt: new Date().toISOString(), phase: 'host-reconciled', processIdentity: expected };",
    "  writeAtomicCallbackEvidence(input.cancelAckFile, JSON.stringify(acknowledgement) + '\\n');",
    "};",
    "const finishGoneProcess = (expected, hasAcknowledgement) => {",
    "  if (!processBirthIsGone(expected)) return false;",
    "  validateExactEvidence(expected);",
    "  let terminalAcknowledgement = hasAcknowledgement;",
    "  if (!terminalAcknowledgement) {",
    "    const appearedAcknowledgement = readJson(input.cancelAckFile, 'Callback cancellation acknowledgement');",
    "    if (appearedAcknowledgement) {",
    "      if (appearedAcknowledgement.schema !== input.ackSchema || appearedAcknowledgement.instanceNonce !== input.instanceNonce || !['server', 'host-reconciled'].includes(appearedAcknowledgement.phase)) throw new Error('A cancellation acknowledgement appeared with mismatched instance authority during reconciliation.');",
    "      const appearedIdentity = validateIdentity(appearedAcknowledgement.processIdentity, 'Sandbox callback bridge cancellation acknowledgement');",
    "      const appearedMismatch = callbackProcessIdentityMismatch(expected, appearedIdentity);",
    "      if (appearedMismatch) throw new Error('A cancellation acknowledgement changed accepted process identity field during reconciliation: ' + appearedMismatch);",
    "      terminalAcknowledgement = true;",
    "    }",
    "  }",
    "  if (!terminalAcknowledgement) writeHostReconciledAck(expected);",
    "  deleteExactEvidence();",
    "  process.stdout.write('cancelled\\n'); process.exit(0);",
    "};",
    "const poll = () => {",
    "  const acknowledgement = readJson(input.cancelAckFile, 'Callback cancellation acknowledgement');",
    "  if (acknowledgement) {",
    "    if (acknowledgement.schema !== input.ackSchema || acknowledgement.instanceNonce !== input.instanceNonce) {",
    "      throw new Error('Sandbox callback bridge wrote a mismatched cancellation acknowledgement.');",
    "    }",
    "    if (acknowledgement.phase === 'prelaunch') {",
    "      if (input.acceptedProcessIdentity || acknowledgement.processIdentity || fs.existsSync(input.readyFile) || fs.existsSync(input.pidFile)) throw new Error('Prelaunch cancellation acknowledgement contradicted accepted process evidence.');",
    "      const launch = readJson(input.launchFile, 'Callback launch');",
    "      if (launch?.state === 'accepted') throw new Error('Prelaunch cancellation acknowledgement contradicted an accepted launch receipt.');",
    "      validateExactEvidence(null);",
    "      deleteExactEvidence();",
    "      process.stdout.write('cancelled\\n'); process.exit(0);",
    "    }",
    "    if (!['server', 'host-reconciled'].includes(acknowledgement.phase)) throw new Error('Sandbox callback bridge cancellation acknowledgement had an invalid phase.');",
    "    const expected = validateIdentity(acknowledgement.processIdentity, 'Sandbox callback bridge cancellation acknowledgement');",
    "    finishGoneProcess(expected, true);",
    "  } else {",
    "    const launch = readJson(input.launchFile, 'Callback launch');",
    "    if (launch) {",
    "      if (launch.schema !== input.launchSchema || launch.instanceNonce !== input.instanceNonce || launch.scriptMarker !== input.scriptMarker) throw new Error('Callback launch evidence belongs to another instance or script marker.');",
    "      if (launch.state === 'accepted') {",
    "        const expected = validateIdentity(launch.processIdentity, 'Accepted callback launch receipt');",
    "        if (launch.pid !== expected.pid) throw new Error('Accepted callback launch receipt pid did not match its process identity.');",
    "        finishGoneProcess(expected, false);",
    "      } else if (!['intent', 'launching'].includes(launch.state)) throw new Error('Callback launch evidence had an invalid state.');",
    "    }",
    "  }",
    "  if (Date.now() >= deadline) { throw new Error('Timed out waiting for sandbox callback bridge nonce cancellation self-cleanup.'); }",
    "  setTimeout(poll, 50);",
    "};",
    "poll();",
  ].join("\n");
  const waitResult = await input.runner.execute({
    command: input.nodeCommand,
    args: [
      "-e",
      waitSource,
      JSON.stringify({
        cancelFile: input.directories.cancelFile,
        cancelAckFile: input.directories.cancelAckFile,
        readyFile: input.directories.readyFile,
        pidFile: input.directories.pidFile,
        launchFile: input.directories.launchFile,
        dispatchClaimFile: input.directories.dispatchClaimFile,
        instanceNonce: input.instanceNonce,
        scriptMarker: input.scriptMarker,
        acceptedProcessIdentity: input.acceptedProcessIdentity,
        ackSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
        launchSchema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
        cancelSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
        dispatchClaimSchema: SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA,
        waitTimeoutMs: Math.min(input.timeoutMs, 15_000),
      }),
    ],
    cwd: input.remoteCwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
    },
    timeoutMs: input.timeoutMs,
  });
  requireSuccessfulResult("verify sandbox callback bridge startup cancellation", waitResult);
  const outcome = waitResult.stdout.trim();
  if (outcome === "cancelled") return outcome;
  throw new Error(`Sandbox callback bridge cancellation verifier returned an invalid outcome: ${outcome || "empty"}.`);
}

function createSandboxCallbackBridgeCancellationController(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  nodeCommand: string;
  directories: SandboxCallbackBridgeDirectories;
  instanceNonce: string;
  scriptMarker: string;
  timeoutMs: number;
}): {
  controller: SandboxCallbackBridgeCancellationController;
  setAcceptedProcessIdentity(identity: SandboxCallbackBridgeProcessIdentity): void;
} {
  let acceptedProcessIdentity: SandboxCallbackBridgeProcessIdentity | null = null;
  let cancellationSucceeded = false;
  let cancellationInFlight: Promise<"cancelled"> | null = null;
  const frozenDirectories = Object.freeze({ ...input.directories });
  const reconcile = async (): Promise<"cancelled"> => {
    if (cancellationSucceeded) return "cancelled";
    if (cancellationInFlight) return await cancellationInFlight;
    const attempt = cancelStartedSandboxCallbackBridge({
      ...input,
      acceptedProcessIdentity,
    });
    cancellationInFlight = attempt;
    try {
      const outcome = await attempt;
      cancellationSucceeded = true;
      return outcome;
    } finally {
      if (!cancellationSucceeded) cancellationInFlight = null;
    }
  };
  const controller: SandboxCallbackBridgeCancellationController = Object.freeze({
    instanceNonce: input.instanceNonce,
    directories: frozenDirectories,
    get acceptedProcessIdentity() {
      return acceptedProcessIdentity;
    },
    cancel: reconcile,
    reconcile,
  });
  return {
    controller,
    setAcceptedProcessIdentity(identity) {
      acceptedProcessIdentity = Object.freeze({ ...identity });
    },
  };
}

/**
 * Discover native callback custody after host loss using only the manifest's
 * queue root and nonce. Absence is never replay authority: every non-accepted
 * result has replaySafe=false, and conflicting evidence returns no controller.
 */
export async function discoverSandboxCallbackBridgeCancellationAuthority(
  input: DiscoverSandboxCallbackBridgeCancellationAuthorityInput,
): Promise<SandboxCallbackBridgeCancellationAuthorityDiscovery> {
  const instanceNonce = input.instanceNonce.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceNonce)) {
    throw new Error("Sandbox callback bridge discovery requires a canonical instance UUID.");
  }
  if (!input.queueDir?.trim()) {
    throw new Error("Sandbox callback bridge discovery requires a non-empty queue root directory.");
  }
  const directories = Object.freeze({ ...sandboxCallbackBridgeDirectories(input.queueDir) });
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const discoverySource = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const input = JSON.parse(process.argv[1]);",
    "const respond = (value) => { process.stdout.write(JSON.stringify(value) + '\\n'); process.exit(0); };",
    "const readJson = (file, label) => { if (!fs.existsSync(file)) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(label + ' evidence is malformed.'); } };",
    "const normalizePath = (value, platform) => { const normalized = String(value).replace(/\\\\/g, '/').replace(/\\/$/, ''); return platform === 'win32' ? normalized.toLowerCase() : normalized; };",
    "const identityMismatch = (expected, actual) => { if (!actual || typeof actual !== 'object') return 'identity'; for (const field of ['schema', 'platform', 'pid', 'bootIdentity', 'osStartIdentity', 'scriptMarker', 'instanceNonce']) if (expected[field] !== actual[field]) return field; return normalizePath(expected.executablePath, expected.platform) === normalizePath(actual.executablePath, actual.platform) ? null : 'executablePath'; };",
    "try {",
    "  const launch = readJson(input.directories.launchFile, 'Callback launch');",
    "  if (!launch) respond({ status: 'accepted_receipt_absent', reason: 'launch_receipt_missing', scriptMarker: null });",
    "  if (launch.schema !== input.launchSchema || launch.instanceNonce !== input.instanceNonce || typeof launch.scriptMarker !== 'string' || !/^[a-f0-9]{64}$/.test(launch.scriptMarker)) throw new Error('Callback launch descriptor did not match discovery authority.');",
    "  let claim = null;",
    "  if (fs.existsSync(input.directories.dispatchClaimFile)) { claim = readJson(path.join(input.directories.dispatchClaimFile, 'owner.json'), 'Callback dispatch claim'); if (!claim) throw new Error('Callback dispatch claim directory is missing its owner receipt.'); if (claim.schema !== input.dispatchClaimSchema || claim.instanceNonce !== input.instanceNonce) throw new Error('Callback dispatch claim did not match discovery authority.'); }",
    "  const cancellation = readJson(input.directories.cancelFile, 'Callback cancellation');",
    "  if (cancellation && (cancellation.schema !== input.cancelSchema || cancellation.instanceNonce !== input.instanceNonce)) throw new Error('Callback cancellation did not match discovery authority.');",
    "  const acknowledgement = readJson(input.directories.cancelAckFile, 'Callback cancellation acknowledgement');",
    "  if (acknowledgement && (acknowledgement.schema !== input.cancelAckSchema || acknowledgement.instanceNonce !== input.instanceNonce)) throw new Error('Callback cancellation acknowledgement did not match discovery authority.');",
    "  if (launch.state !== 'accepted') {",
    "    if (!['intent', 'launching'].includes(launch.state)) throw new Error('Callback launch descriptor had an invalid non-accepted state.');",
    "    if (launch.state === 'launching' && !claim) throw new Error('Callback launching descriptor had no dispatch claim.');",
    "    if (fs.existsSync(input.directories.readyFile) || fs.existsSync(input.directories.pidFile)) throw new Error('Callback non-accepted launch contradicted native process evidence.');",
    "    if (acknowledgement && acknowledgement.phase !== 'prelaunch') throw new Error('Callback non-accepted launch contradicted a process cancellation acknowledgement.');",
    "    respond({ status: 'accepted_receipt_absent', reason: 'launch_not_accepted', scriptMarker: launch.scriptMarker });",
    "  }",
    "  if (!claim) throw new Error('Callback accepted launch had no dispatch claim.');",
    "  const identity = launch.processIdentity;",
    "  if (!identity || identity.schema !== input.identitySchema || !['linux', 'win32'].includes(identity.platform) || identity.platform !== process.platform || !Number.isInteger(identity.pid) || identity.pid <= 0 || typeof identity.bootIdentity !== 'string' || !identity.bootIdentity || typeof identity.osStartIdentity !== 'string' || !identity.osStartIdentity || typeof identity.executablePath !== 'string' || !identity.executablePath || identity.scriptMarker !== launch.scriptMarker || identity.instanceNonce !== input.instanceNonce || launch.pid !== identity.pid) throw new Error('Callback accepted launch process identity was malformed or mismatched.');",
    "  const readiness = readJson(input.directories.readyFile, 'Callback readiness');",
    "  if (readiness) { if (readiness.pid !== identity.pid) throw new Error('Callback readiness pid changed accepted identity.'); const mismatch = identityMismatch(identity, readiness.processIdentity); if (mismatch) throw new Error('Callback readiness changed accepted process identity field: ' + mismatch); }",
    "  if (fs.existsSync(input.directories.pidFile)) { const pid = Number(fs.readFileSync(input.directories.pidFile, 'utf8').trim()); if (!Number.isInteger(pid) || pid !== identity.pid) throw new Error('Callback pid receipt changed accepted identity.'); }",
    "  if (acknowledgement) { if (!['server', 'host-reconciled'].includes(acknowledgement.phase)) throw new Error('Callback accepted launch contradicted cancellation phase.'); const mismatch = identityMismatch(identity, acknowledgement.processIdentity); if (mismatch) throw new Error('Callback cancellation acknowledgement changed accepted process identity field: ' + mismatch); }",
    "  respond({ status: 'accepted', scriptMarker: launch.scriptMarker, processIdentity: identity });",
    "} catch (error) { respond({ status: 'conflict', reason: error instanceof Error ? error.message : String(error) }); }",
  ].join("\n");
  const discoveryResult = await input.runner.execute({
    command: nodeCommand,
    args: [
      "-e",
      discoverySource,
      JSON.stringify({
        directories,
        instanceNonce,
        launchSchema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
        dispatchClaimSchema: SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA,
        cancelSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
        cancelAckSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
        identitySchema: SANDBOX_CALLBACK_BRIDGE_PROCESS_IDENTITY_SCHEMA,
      }),
    ],
    cwd: input.remoteCwd,
    env: { [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE },
    timeoutMs,
  });
  requireSuccessfulResult("discover sandbox callback bridge cancellation authority", discoveryResult);
  let observed: Record<string, unknown>;
  try {
    observed = JSON.parse(discoveryResult.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("Sandbox callback bridge discovery returned malformed evidence.");
  }
  if (observed.status === "conflict") {
    return Object.freeze({
      status: "conflict",
      replaySafe: false,
      reason: typeof observed.reason === "string" && observed.reason ? observed.reason : "Native callback evidence conflicted.",
      instanceNonce,
      scriptMarker: null,
      processIdentity: null,
      directories,
      cancellationController: null,
    });
  }
  if (observed.status === "accepted_receipt_absent") {
    const reason = observed.reason === "launch_not_accepted" ? "launch_not_accepted" : "launch_receipt_missing";
    const scriptMarker = typeof observed.scriptMarker === "string" && /^[a-f0-9]{64}$/.test(observed.scriptMarker)
      ? observed.scriptMarker
      : null;
    const cancellation = scriptMarker
      ? createSandboxCallbackBridgeCancellationController({
        runner: input.runner,
        remoteCwd: input.remoteCwd,
        nodeCommand,
        directories,
        instanceNonce,
        scriptMarker,
        timeoutMs,
      }).controller
      : null;
    return Object.freeze({
      status: "accepted_receipt_absent",
      replaySafe: false,
      reason,
      instanceNonce,
      scriptMarker,
      processIdentity: null,
      directories,
      cancellationController: cancellation,
    });
  }
  if (observed.status !== "accepted" || typeof observed.scriptMarker !== "string") {
    throw new Error("Sandbox callback bridge discovery returned an invalid outcome.");
  }
  const processIdentity = parseSandboxCallbackBridgeProcessIdentity(observed.processIdentity);
  if (
    !processIdentity ||
    processIdentity.instanceNonce !== instanceNonce ||
    processIdentity.scriptMarker !== observed.scriptMarker
  ) {
    throw new Error("Sandbox callback bridge discovery returned an invalid accepted identity.");
  }
  const frozenIdentity = Object.freeze({ ...processIdentity });
  const cancellation = createSandboxCallbackBridgeCancellationController({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    nodeCommand,
    directories,
    instanceNonce,
    scriptMarker: observed.scriptMarker,
    timeoutMs,
  });
  cancellation.setAcceptedProcessIdentity(frozenIdentity);
  return Object.freeze({
    status: "accepted",
    replaySafe: false,
    instanceNonce,
    scriptMarker: observed.scriptMarker,
    processIdentity: frozenIdentity,
    directories,
    cancellationController: cancellation.controller,
  });
}

/**
 * Rebuild cancellation authority after host/controller loss. This is a
 * read-only adoption step: it validates the caller's immutable manifest fields
 * against exact accepted remote receipts, but never launches, cancels, or
 * releases anything until the returned controller is explicitly invoked.
 */
export async function rehydrateSandboxCallbackBridgeCancellationController(
  input: RehydrateSandboxCallbackBridgeCancellationControllerInput,
): Promise<SandboxCallbackBridgeCancellationController> {
  const instanceNonce = input.instanceNonce.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceNonce)) {
    throw new Error("Sandbox callback bridge rehydration requires a canonical instance UUID.");
  }
  const scriptMarker = input.scriptMarker.trim();
  if (!/^[a-f0-9]{64}$/.test(scriptMarker)) {
    throw new Error("Sandbox callback bridge rehydration requires an exact lowercase SHA-256 script marker.");
  }
  const parsedIdentity = parseSandboxCallbackBridgeProcessIdentity(input.processIdentity);
  if (!parsedIdentity) {
    throw new Error("Sandbox callback bridge rehydration process identity is malformed or incomplete.");
  }
  if (parsedIdentity.instanceNonce !== instanceNonce || parsedIdentity.scriptMarker !== scriptMarker) {
    throw new Error("Sandbox callback bridge rehydration identity did not match its manifest nonce and script marker.");
  }
  const processIdentity = Object.freeze({ ...parsedIdentity });
  const directories = Object.freeze({ ...input.directories });
  if (!directories.rootDir?.trim()) {
    throw new Error("Sandbox callback bridge rehydration requires a non-empty queue root directory.");
  }
  const expectedDirectories = sandboxCallbackBridgeDirectories(directories.rootDir);
  for (const key of Object.keys(expectedDirectories) as Array<keyof SandboxCallbackBridgeDirectories>) {
    if (
      normalizeProcessIdentityPath(directories[key], processIdentity.platform) !==
      normalizeProcessIdentityPath(expectedDirectories[key], processIdentity.platform)
    ) {
      throw new Error(`Sandbox callback bridge rehydration directory ${key} did not derive from its queue root.`);
    }
  }

  const validationSource = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const input = JSON.parse(process.argv[1]);",
    "const readJson = (file, label, required = false) => { if (!fs.existsSync(file)) { if (required) throw new Error(label + ' evidence is missing.'); return null; } try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(label + ' evidence is malformed.'); } };",
    "const normalizePath = (value, platform) => { const normalized = String(value).replace(/\\\\/g, '/').replace(/\\/$/, ''); return platform === 'win32' ? normalized.toLowerCase() : normalized; };",
    "const identityMismatch = (expected, actual) => {",
    "  if (!actual || typeof actual !== 'object') return 'identity';",
    "  for (const field of ['schema', 'platform', 'pid', 'bootIdentity', 'osStartIdentity', 'scriptMarker', 'instanceNonce']) if (expected[field] !== actual[field]) return field;",
    "  return normalizePath(expected.executablePath, expected.platform) === normalizePath(actual.executablePath, actual.platform) ? null : 'executablePath';",
    "};",
    "const assertIdentity = (actual, label) => { const mismatch = identityMismatch(input.processIdentity, actual); if (mismatch) throw new Error(label + ' changed accepted process identity field: ' + mismatch); };",
    "const claim = readJson(path.join(input.directories.dispatchClaimFile, 'owner.json'), 'Callback dispatch claim', true);",
    "if (claim.schema !== input.dispatchClaimSchema || claim.instanceNonce !== input.instanceNonce) throw new Error('Callback dispatch claim did not match rehydration authority.');",
    "const launch = readJson(input.directories.launchFile, 'Callback accepted launch', true);",
    "if (launch.schema !== input.launchSchema || launch.instanceNonce !== input.instanceNonce || launch.scriptMarker !== input.scriptMarker || launch.state !== 'accepted' || launch.pid !== input.processIdentity.pid) throw new Error('Callback accepted launch did not match rehydration authority.');",
    "assertIdentity(launch.processIdentity, 'Callback accepted launch');",
    "const readiness = readJson(input.directories.readyFile, 'Callback readiness');",
    "if (readiness) { if (readiness.pid !== input.processIdentity.pid) throw new Error('Callback readiness pid did not match rehydration authority.'); assertIdentity(readiness.processIdentity, 'Callback readiness'); }",
    "if (fs.existsSync(input.directories.pidFile)) { const pid = Number(fs.readFileSync(input.directories.pidFile, 'utf8').trim()); if (!Number.isInteger(pid) || pid !== input.processIdentity.pid) throw new Error('Callback pid receipt did not match rehydration authority.'); }",
    "const cancellation = readJson(input.directories.cancelFile, 'Callback cancellation');",
    "if (cancellation && (cancellation.schema !== input.cancelSchema || cancellation.instanceNonce !== input.instanceNonce)) throw new Error('Callback cancellation did not match rehydration authority.');",
    "const acknowledgement = readJson(input.directories.cancelAckFile, 'Callback cancellation acknowledgement');",
    "if (acknowledgement) { if (acknowledgement.schema !== input.cancelAckSchema || acknowledgement.instanceNonce !== input.instanceNonce || !['server', 'host-reconciled'].includes(acknowledgement.phase)) throw new Error('Callback cancellation acknowledgement did not match accepted rehydration authority.'); assertIdentity(acknowledgement.processIdentity, 'Callback cancellation acknowledgement'); }",
    "process.stdout.write('validated\\n');",
  ].join("\n");
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const validationResult = await input.runner.execute({
    command: nodeCommand,
    args: [
      "-e",
      validationSource,
      JSON.stringify({
        directories,
        instanceNonce,
        scriptMarker,
        processIdentity,
        launchSchema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
        dispatchClaimSchema: SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA,
        cancelSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
        cancelAckSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
      }),
    ],
    cwd: input.remoteCwd,
    env: { [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE },
    timeoutMs,
  });
  requireSuccessfulResult("rehydrate sandbox callback bridge cancellation authority", validationResult);
  if (validationResult.stdout.trim() !== "validated") {
    throw new Error("Sandbox callback bridge rehydration validator returned an invalid outcome.");
  }

  const cancellation = createSandboxCallbackBridgeCancellationController({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    nodeCommand,
    directories,
    instanceNonce,
    scriptMarker,
    timeoutMs,
  });
  cancellation.setAcceptedProcessIdentity(processIdentity);
  return cancellation.controller;
}

export async function startSandboxCallbackBridgeServer(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  queueDir: string;
  bridgeToken: string;
  bridgeAsset?: SandboxCallbackBridgeAsset | null;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  timeoutMs?: number | null;
  nodeCommand?: string;
  shellCommand?: "bash" | "sh" | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
  /** Caller-owned run/instance correlation id; must be a canonical UUID when supplied. */
  instanceNonce?: string | null;
}): Promise<StartedSandboxCallbackBridgeServer> {
  const requestedInstanceNonce = input.instanceNonce?.trim() || null;
  if (
    input.instanceNonce != null &&
    (!requestedInstanceNonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedInstanceNonce))
  ) {
    throw new Error("Sandbox callback bridge instanceNonce must be a canonical UUID.");
  }
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  let remoteEntrypoint = joinPortablePath(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  if (input.bridgeAsset) {
    const assetSync = await syncSandboxCallbackBridgeEntrypoint({
      runner: input.runner,
      remoteCwd: input.remoteCwd,
      assetRemoteDir: input.assetRemoteDir,
      bridgeAsset: input.bridgeAsset,
      timeoutMs,
      shellCommand,
    });
    remoteEntrypoint = assetSync.remoteEntrypoint;
  }
  const env = buildSandboxCallbackBridgeEnv({
    queueDir: input.queueDir,
    bridgeToken: input.bridgeToken,
    host: input.host,
    port: input.port,
    pollIntervalMs: input.pollIntervalMs,
    responseTimeoutMs: input.responseTimeoutMs,
    maxQueueDepth: input.maxQueueDepth,
    maxBodyBytes: input.maxBodyBytes,
  });
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const instanceNonce = requestedInstanceNonce ?? randomUUID();
  const scriptMarker = createHash("sha256")
    .update(normalizeProcessIdentityPath(remoteEntrypoint, process.platform === "win32" ? "win32" : "linux"))
    .digest("hex");
  const cancellation = createSandboxCallbackBridgeCancellationController({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    nodeCommand,
    directories,
    instanceNonce,
    scriptMarker,
    timeoutMs,
  });
  await persistSandboxCallbackBridgeLaunchIntent({
    runner: input.runner,
    remoteCwd: input.remoteCwd,
    nodeCommand,
    directories,
    instanceNonce,
    scriptMarker,
    timeoutMs,
  });
  const rejectAfterPotentialLaunch = async (error: unknown): Promise<never> => {
    const launchError = error instanceof Error ? error : new Error(String(error));
    try {
      await cancellation.controller.reconcile();
    } catch (cancellationError) {
      throw new SandboxCallbackBridgeLaunchAmbiguousError({
        detail: "Nonce cancellation self-cleanup could not be proven; evidence and controller authority were preserved.",
        causes: [launchError, cancellationError],
        controller: cancellation.controller,
        acceptedStart: cancellation.controller.acceptedProcessIdentity ? "accepted" : "unknown",
      });
    }
    throw launchError;
  };
  const prelaunchGateInput = Buffer.from(JSON.stringify({
    launchFile: directories.launchFile,
    dispatchClaimFile: directories.dispatchClaimFile,
    cancelFile: directories.cancelFile,
    cancelAckFile: directories.cancelAckFile,
    readyFile: directories.readyFile,
    pidFile: directories.pidFile,
    launchSchema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
    cancelSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA,
    cancelAckSchema: SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA,
    dispatchClaimSchema: SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA,
    instanceNonce,
    scriptMarker,
  }), "utf8").toString("base64");
  const launchAcceptanceInput = Buffer.from(JSON.stringify({
    launchFile: directories.launchFile,
    launchSchema: SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA,
    instanceNonce,
    scriptMarker,
    waitTimeoutMs: Math.min(timeoutMs, 20_000),
  }), "utf8").toString("base64");
  try {
  const startResult = await input.runner.execute({
    command: shellCommand,
    args: shellCommandArgs(
      [
          "set -eu",
          "umask 077",
          `mkdir -p ${shellQuotePath(directories.requestsDir)} ${shellQuotePath(directories.responsesDir)} ${shellQuotePath(directories.logsDir)}`,
          `chmod 700 ${shellQuotePath(directories.rootDir)} 2>/dev/null || true`,
          `gate_result="$(PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT=${shellQuote(prelaunchGateInput)} ` +
            `${shellQuotePath(nodeCommand)} ${shellQuotePath(remoteEntrypoint)} ` +
            `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_NONCE_ARG}${instanceNonce}`)} ` +
            `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_SCRIPT_MARKER_ARG}${scriptMarker}`)})"`,
          `if [ "$gate_result" = "cancelled" ]; then printf 'PAPERCLIP_CALLBACK_BRIDGE_START=cancelled\\n'; exit 0; fi`,
          `if [ "$gate_result" = "duplicate" ]; then printf 'PAPERCLIP_CALLBACK_BRIDGE_START=duplicate\\n'; exit 0; fi`,
          `if [ "$gate_result" != "proceed" ]; then echo "Invalid callback bridge prelaunch gate result." >&2; exit 1; fi`,
        `nohup ${shellQuotePath(nodeCommand)} ${shellQuotePath(remoteEntrypoint)} ` +
          `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_NONCE_ARG}${instanceNonce}`)} ` +
          `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_SCRIPT_MARKER_ARG}${scriptMarker}`)} ` +
          `>> ${shellQuotePath(directories.logFile)} 2>&1 < /dev/null &`,
        "pid=$!",
        `PAPERCLIP_BRIDGE_WAIT_ACCEPTED_INPUT=${shellQuote(launchAcceptanceInput)} ` +
          `${shellQuotePath(nodeCommand)} ${shellQuotePath(remoteEntrypoint)} ` +
          `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_NONCE_ARG}${instanceNonce}`)} ` +
          `${shellQuote(`${SANDBOX_CALLBACK_BRIDGE_SCRIPT_MARKER_ARG}${scriptMarker}`)} >/dev/null`,
        "printf '{\"pid\":%s}\\n' \"$pid\"",
      ].join("\n"),
    ),
    cwd: input.remoteCwd,
    env: {
      [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE,
      ...env,
    },
    timeoutMs,
    });
    requireSuccessfulResult("start sandbox callback bridge", startResult);
    if (startResult.stdout.includes("PAPERCLIP_CALLBACK_BRIDGE_START=cancelled")) {
      throw new Error("Sandbox callback bridge launch was nonce-cancelled before process acceptance.");
    }
  } catch (error) {
    return await rejectAfterPotentialLaunch(error);
  }

  const readiness = await (async () => {
  const readyResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "i=0",
      `while [ \"$i\" -lt 200 ]; do`,
      `  if [ -s ${shellQuotePath(directories.readyFile)} ]; then`,
      `    cat ${shellQuotePath(directories.readyFile)}`,
      "    exit 0",
      "  fi",
      `  if [ -s ${shellQuotePath(directories.logFile)} ] && ! kill -0 \"$(cat ${shellQuotePath(directories.pidFile)} 2>/dev/null)\" 2>/dev/null; then`,
      `    cat ${shellQuotePath(directories.logFile)} >&2`,
      "    exit 1",
      "  fi",
      "  i=$((i + 1))",
      "  sleep 0.05",
      "done",
      `echo "Timed out waiting for bridge readiness." >&2`,
      `if [ -s ${shellQuotePath(directories.logFile)} ]; then cat ${shellQuotePath(directories.logFile)} >&2; fi`,
      "exit 1",
    ].join("\n"),
    timeoutMs,
    shellCommand,
  );
  requireSuccessfulResult("wait for sandbox callback bridge readiness", readyResult);

  let readyData: {
    host?: string;
    port?: number;
    baseUrl?: string;
    pid?: number;
    ppid?: number;
    processIdentity?: unknown;
  };
  try {
    readyData = JSON.parse(readyResult.stdout.trim()) as {
      host?: string;
      port?: number;
      baseUrl?: string;
      pid?: number;
      ppid?: number;
      processIdentity?: unknown;
    };
  } catch (error) {
    throw new Error(
      `Sandbox callback bridge wrote invalid readiness JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const host = typeof readyData.host === "string" && readyData.host.trim().length > 0
    ? readyData.host.trim()
    : "127.0.0.1";
  const port = typeof readyData.port === "number" && Number.isFinite(readyData.port) ? readyData.port : 0;
  if (!port) {
    throw new Error("Sandbox callback bridge did not report a listening port.");
  }
  const expectedPid =
    typeof readyData.pid === "number" && Number.isInteger(readyData.pid) && readyData.pid > 0
      ? readyData.pid
      : 0;
  if (!expectedPid) {
    throw new Error("Sandbox callback bridge did not report a positive process id.");
  }
  const expectedParentPid =
    typeof readyData.ppid === "number" && Number.isInteger(readyData.ppid) && readyData.ppid > 0
      ? readyData.ppid
      : 0;
  const parsedProcessIdentity = parseSandboxCallbackBridgeProcessIdentity(readyData.processIdentity);
  if (!parsedProcessIdentity) {
    throw new Error("Sandbox callback bridge did not report a complete process birth identity.");
  }
  const acceptedProcessIdentity = Object.freeze({ ...parsedProcessIdentity });
  if (acceptedProcessIdentity.pid !== expectedPid) {
    throw new Error("Sandbox callback bridge process identity did not match its reported process id.");
  }
  if (
    acceptedProcessIdentity.instanceNonce !== instanceNonce ||
    acceptedProcessIdentity.scriptMarker !== scriptMarker
  ) {
    throw new Error("Sandbox callback bridge process identity did not match its launch markers.");
  }
  cancellation.setAcceptedProcessIdentity(acceptedProcessIdentity);
  const baseUrl =
    typeof readyData.baseUrl === "string" && readyData.baseUrl.trim().length > 0
      ? readyData.baseUrl.trim()
      : `http://${host}:${port}`;

  return { host, port, expectedPid, expectedParentPid, acceptedProcessIdentity, baseUrl };
  })().catch(async (error: unknown) => {
    return await rejectAfterPotentialLaunch(error);
  });
  const {
    host,
    port,
    expectedPid,
    expectedParentPid,
    acceptedProcessIdentity,
    baseUrl,
  } = readiness;

  const stop = async (): Promise<void> => {
    await cancellation.controller.cancel();
  };

  return {
    baseUrl,
    host,
    port,
    pid: expectedPid,
    parentPid: expectedParentPid,
    processIdentity: Object.freeze({ ...acceptedProcessIdentity }),
    directories,
    stop,
  };
}

function getSandboxCallbackBridgeServerSource(): string {
  return `import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const queueDir = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR;
const bridgeToken = process.env.PAPERCLIP_BRIDGE_TOKEN;
const host = process.env.PAPERCLIP_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.PAPERCLIP_BRIDGE_PORT || "0");
const pollIntervalMs = Number(process.env.PAPERCLIP_BRIDGE_POLL_INTERVAL_MS || "100");
const responseTimeoutMs = Number(process.env.PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS || "30000");
const maxQueueDepth = Number(process.env.PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH || "${DEFAULT_BRIDGE_MAX_QUEUE_DEPTH}");
const maxBodyBytes = Number(process.env.PAPERCLIP_BRIDGE_MAX_BODY_BYTES || "${DEFAULT_BRIDGE_MAX_BODY_BYTES}");
const allowedHeaders = new Set(${JSON.stringify([...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST])});

${getSandboxCallbackBridgeProcessProbeSource()}
${getSandboxCallbackBridgeDurableEvidenceSource()}

if (!queueDir || !bridgeToken) {
  throw new Error("PAPERCLIP_BRIDGE_QUEUE_DIR and PAPERCLIP_BRIDGE_TOKEN are required.");
}

const requestsDir = path.posix.join(queueDir, "requests");
const responsesDir = path.posix.join(queueDir, "responses");
const logsDir = path.posix.join(queueDir, "logs");
const readyFile = path.posix.join(queueDir, "ready.json");
const pidFile = path.posix.join(queueDir, "server.pid");
const cancelFile = path.posix.join(queueDir, "startup-cancel.json");
const cancelAckFile = path.posix.join(queueDir, "startup-cancelled.json");
const launchFile = path.posix.join(queueDir, "startup-launch.json");
const dispatchClaimFile = path.posix.join(queueDir, "startup-dispatch.claim");
const instanceNonce = extractUniqueArrayFlag(process.argv, callbackNonceArg);
const scriptMarker = extractUniqueArrayFlag(process.argv, callbackScriptMarkerArg);

if (!instanceNonce || !scriptMarker) {
  throw new Error("Sandbox callback bridge requires one launch instance nonce and script marker.");
}

const encodedPrelaunchGateInput = process.env.PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT || "";
if (encodedPrelaunchGateInput) {
  const input = JSON.parse(Buffer.from(encodedPrelaunchGateInput, "base64").toString("utf8"));
  const sameExactPath = (left, right) => {
    const normalize = (value) => {
      const slashed = String(value).split(String.fromCharCode(92)).join("/");
      const trimmed = slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
      return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    };
    return normalize(left) === normalize(right);
  };
  if (
    input.instanceNonce !== instanceNonce || input.scriptMarker !== scriptMarker ||
    !sameExactPath(input.launchFile, launchFile) || !sameExactPath(input.dispatchClaimFile, dispatchClaimFile) ||
    !sameExactPath(input.cancelFile, cancelFile) || !sameExactPath(input.cancelAckFile, cancelAckFile) ||
    !sameExactPath(input.readyFile, readyFile) || !sameExactPath(input.pidFile, pidFile)
  ) throw new Error("Callback prelaunch gate input did not match its exact instance paths and markers.");
  const read = (file) => {
    if (!fsSync.existsSync(file)) return null;
    try { return JSON.parse(fsSync.readFileSync(file, "utf8")); }
    catch { throw new Error("Callback launch gate evidence is malformed: " + file); }
  };
  const launch = read(launchFile);
  if (!launch || launch.schema !== input.launchSchema || launch.instanceNonce !== instanceNonce || launch.scriptMarker !== scriptMarker) {
    throw new Error("Callback pre-dispatch launch intent is missing or mismatched.");
  }
  const acknowledgement = read(cancelAckFile);
  if (acknowledgement) {
    if (acknowledgement.schema !== input.cancelAckSchema || acknowledgement.instanceNonce !== instanceNonce) {
      throw new Error("Callback cancellation acknowledgement belongs to another instance.");
    }
    process.stdout.write("cancelled\\n");
    process.exit(0);
  }
  let ownsDispatchClaim = false;
  try { fsSync.mkdirSync(dispatchClaimFile, { mode: 0o700 }); ownsDispatchClaim = true; }
  catch (error) { if (!error || error.code !== "EEXIST") throw error; }
  const claimOwnerFile = path.join(dispatchClaimFile, "owner.json");
  if (ownsDispatchClaim) {
    const claim = { schema: input.dispatchClaimSchema, instanceNonce, claimedAt: new Date().toISOString() };
    writeAtomicCallbackEvidence(claimOwnerFile, JSON.stringify(claim) + "\\n");
    if (process.platform !== "win32") {
      const root = fsSync.openSync(path.dirname(dispatchClaimFile), "r");
      try { fsSync.fsyncSync(root); } finally { fsSync.closeSync(root); }
    }
  } else {
    const deadline = Date.now() + 1000;
    let claim = null;
    while (!claim && Date.now() < deadline) {
      try { claim = JSON.parse(fsSync.readFileSync(claimOwnerFile, "utf8")); }
      catch (error) { if (!error || (error.code !== "ENOENT" && !(error instanceof SyntaxError))) throw error; }
      if (!claim) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!claim || claim.schema !== input.dispatchClaimSchema || claim.instanceNonce !== instanceNonce) {
      throw new Error("Callback dispatch claim was unavailable or belonged to another instance.");
    }
    process.stdout.write("duplicate\\n");
    process.exit(0);
  }
  const cancellation = read(cancelFile);
  if (cancellation) {
    if (cancellation.schema !== input.cancelSchema || cancellation.instanceNonce !== instanceNonce) {
      throw new Error("Callback cancellation tombstone belongs to another instance.");
    }
    if (fsSync.existsSync(readyFile) || fsSync.existsSync(pidFile)) {
      throw new Error("Prelaunch cancellation found unexpected live-process evidence.");
    }
    const ack = { schema: input.cancelAckSchema, instanceNonce, cancelledAt: new Date().toISOString(), phase: "prelaunch" };
    writeAtomicCallbackEvidence(cancelAckFile, JSON.stringify(ack) + "\\n");
    fsSync.rmSync(launchFile, { force: true });
    fsSync.rmSync(cancelFile, { force: true });
    fsSync.rmSync(dispatchClaimFile, { recursive: true, force: true });
    process.stdout.write("cancelled\\n");
    process.exit(0);
  }
  writeAtomicCallbackEvidence(launchFile, JSON.stringify({ ...launch, state: "launching", gatedAt: new Date().toISOString() }) + "\\n");
  process.stdout.write("proceed\\n");
  process.exit(0);
}

const encodedAcceptedWaitInput = process.env.PAPERCLIP_BRIDGE_WAIT_ACCEPTED_INPUT || "";
if (encodedAcceptedWaitInput) {
  const input = JSON.parse(Buffer.from(encodedAcceptedWaitInput, "base64").toString("utf8"));
  const normalizePath = (value) => {
    const slashed = String(value).split(String.fromCharCode(92)).join("/");
    const trimmed = slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const normalizedInputLaunch = normalizePath(input.launchFile);
  const normalizedLaunch = normalizePath(launchFile);
  if (normalizedInputLaunch !== normalizedLaunch || input.instanceNonce !== instanceNonce || input.scriptMarker !== scriptMarker) {
    throw new Error("Accepted callback launch waiter did not match its exact instance.");
  }
  const deadline = Date.now() + Number(input.waitTimeoutMs || 0);
  while (Date.now() < deadline) {
    let launch = null;
    try { launch = JSON.parse(fsSync.readFileSync(launchFile, "utf8")); }
    catch (error) { if (!error || (error.code !== "ENOENT" && !(error instanceof SyntaxError))) throw error; }
    if (launch?.state === "accepted") {
      const identity = launch.processIdentity;
      if (
        launch.schema !== input.launchSchema || launch.instanceNonce !== instanceNonce || launch.scriptMarker !== scriptMarker ||
        launch.pid !== identity?.pid || identity?.instanceNonce !== instanceNonce ||
        identity?.scriptMarker !== scriptMarker
      ) throw new Error("Accepted callback launch receipt was malformed or mismatched.");
      process.stdout.write(String(identity.pid) + "\\n");
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for accepted callback launch birth identity receipt.");
}

const startupProcessIdentityProbe = probeCallbackProcessIdentity(process.pid);
if (startupProcessIdentityProbe.status !== "present") {
  throw new Error(startupProcessIdentityProbe.reason || "Callback server could not establish its startup process birth identity.");
}
const startupProcessIdentity = Object.freeze({ ...startupProcessIdentityProbe.identity });
if (startupProcessIdentity.instanceNonce !== instanceNonce || startupProcessIdentity.scriptMarker !== scriptMarker) {
  throw new Error("Callback server startup process birth identity did not match its launch markers.");
}
let startupLaunch;
try { startupLaunch = JSON.parse(fsSync.readFileSync(launchFile, "utf8")); }
catch { throw new Error("Callback launch intent was unavailable while accepting server birth identity."); }
if (
  startupLaunch.schema !== "${SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA}" ||
  startupLaunch.instanceNonce !== instanceNonce ||
  startupLaunch.scriptMarker !== scriptMarker ||
  !["intent", "launching", "accepted"].includes(startupLaunch.state)
) throw new Error("Callback launch intent changed before server birth identity acceptance.");
let dispatchClaim;
try { dispatchClaim = JSON.parse(fsSync.readFileSync(path.join(dispatchClaimFile, "owner.json"), "utf8")); }
catch { throw new Error("Callback dispatch claim was unavailable while accepting server birth identity."); }
if (
  dispatchClaim.schema !== "${SANDBOX_CALLBACK_BRIDGE_DISPATCH_CLAIM_SCHEMA}" ||
  dispatchClaim.instanceNonce !== instanceNonce
) throw new Error("Callback dispatch claim did not match the accepted server instance.");
if (startupLaunch.state === "accepted" && startupLaunch.processIdentity) {
  const mismatch = callbackProcessIdentityMismatch(startupLaunch.processIdentity, startupProcessIdentity);
  if (mismatch) throw new Error("Existing callback accepted launch identity changed field: " + mismatch);
} else {
  const accepted = {
    schema: "${SANDBOX_CALLBACK_BRIDGE_LAUNCH_SCHEMA}",
    instanceNonce,
    scriptMarker,
    state: "accepted",
    pid: process.pid,
    processIdentity: startupProcessIdentity,
    acceptedAt: new Date().toISOString(),
  };
  writeAtomicCallbackEvidence(launchFile, JSON.stringify(accepted) + "\\n");
}
writeAtomicCallbackEvidence(pidFile, String(process.pid) + "\\n");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const normalizedKey = key.toLowerCase();
    if (!allowedHeaders.has(normalizedKey)) {
      continue;
    }
    out[normalizedKey] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(nextChunk);
    totalBytes += nextChunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new Error("Bridge request body exceeded the configured size limit.");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function queueDepth() {
  const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

function tokensMatch(received) {
  const expected = Buffer.from(bridgeToken, "utf8");
  const actual = Buffer.from(typeof received === "string" ? received : "", "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function waitForResponse(requestId) {
  const responsePath = path.posix.join(responsesDir, \`\${requestId}.json\`);
  const deadline = Date.now() + responseTimeoutMs;
  while (Date.now() < deadline) {
    const body = await fs.readFile(responsePath, "utf8").catch(() => null);
    if (body != null) {
      await fs.rm(responsePath, { force: true }).catch(() => undefined);
      return JSON.parse(body);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("Timed out waiting for host bridge response.");
}

const server = createServer(async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!tokensMatch(receivedToken)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Invalid bridge token." }));
      return;
    }

    if (await queueDepth() >= maxQueueDepth) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge request queue is full." }));
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
    if (req.method && req.method !== "GET" && req.method !== "HEAD" && !/json/i.test(contentType)) {
      res.statusCode = 415;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge only accepts JSON request bodies." }));
      return;
    }
    const requestId = randomUUID();
    const requestBody = await readBody(req);
    const payload = {
      id: requestId,
      method: req.method || "GET",
      path: url.pathname,
      query: url.search,
      headers: normalizeHeaders(req.headers),
      body: requestBody,
      createdAt: new Date().toISOString(),
    };
    const requestPath = path.posix.join(requestsDir, \`\${requestId}.json\`);
    const tempPath = \`\${requestPath}.tmp\`;
    await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, "utf8");
    await fs.rename(tempPath, requestPath);

    const response = await waitForResponse(requestId);
    res.statusCode = typeof response.status === "number" ? response.status : 200;
    for (const [key, value] of Object.entries(response.headers || {})) {
      if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
      res.setHeader(key, value);
    }
    res.end(typeof response.body === "string" ? response.body : "");
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

let startupCancellationTimer = null;
let startupCancellationInFlight = false;
const serverProcessIdentity = startupProcessIdentity;

function cancellationNonceMatches(received) {
  const expected = Buffer.from(instanceNonce, "utf8");
  const actual = Buffer.from(typeof received === "string" ? received : "", "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function completeStartupCancellation() {
  if (startupCancellationInFlight) return;
  startupCancellationInFlight = true;
  if (startupCancellationTimer && typeof startupCancellationTimer.ref === "function") startupCancellationTimer.ref();
  try {
    if (!serverProcessIdentity) throw new Error("Sandbox callback bridge cannot acknowledge cancellation without its process birth identity.");
    const acknowledgement = {
      schema: "${SANDBOX_CALLBACK_BRIDGE_CANCEL_ACK_SCHEMA}",
      instanceNonce,
      cancelledAt: new Date().toISOString(),
      phase: "server",
      processIdentity: serverProcessIdentity,
    };
    writeAtomicCallbackEvidence(cancelAckFile, JSON.stringify(acknowledgement) + "\\n");
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    }
    if (startupCancellationTimer) clearInterval(startupCancellationTimer);
    // The server never deletes custody evidence. Only the host-side controller,
    // after proving this exact birth is absent and validating every receipt,
    // may remove it. This avoids an ack->cleanup race erasing contradictory
    // same-nonce evidence or a PID-reuse signal.
    process.exit(0);
  } catch (error) {
    startupCancellationInFlight = false;
    throw error;
  }
}

async function inspectStartupCancellation() {
  if (startupCancellationInFlight) return;
  const raw = await fs.readFile(cancelFile, "utf8").catch(() => null);
  if (raw == null) return;
  let cancellation;
  try { cancellation = JSON.parse(raw); } catch { return; }
  if (
    cancellation?.schema !== "${SANDBOX_CALLBACK_BRIDGE_CANCEL_SCHEMA}" ||
    !cancellationNonceMatches(cancellation.instanceNonce)
  ) return;
  await completeStartupCancellation();
}

async function shutdown() {
  if (startupCancellationTimer) clearInterval(startupCancellationTimer);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await fs.mkdir(requestsDir, { recursive: true });
await fs.mkdir(responsesDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true });

server.listen(port, host, async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bridge server did not expose a TCP address.");
  }
  const ready = {
    pid: process.pid,
    ppid: process.ppid,
    processIdentity: serverProcessIdentity,
    host,
    port: address.port,
    baseUrl: \`http://\${host}:\${address.port}\`,
    startedAt: new Date().toISOString(),
  };
  const tempReadyFile = \`\${readyFile}.tmp\`;
  await fs.writeFile(tempReadyFile, JSON.stringify(ready), "utf8");
  await fs.rename(tempReadyFile, readyFile);
  startupCancellationTimer = setInterval(() => {
    void inspectStartupCancellation().catch((error) => {
      process.stderr.write("Sandbox callback bridge startup cancellation failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
    });
  }, 50);
  startupCancellationTimer.unref();
});`;
}
