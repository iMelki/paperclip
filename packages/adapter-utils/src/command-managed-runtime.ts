import path from "node:path";
import {
  prepareSandboxManagedRuntime,
  type PreparedSandboxManagedRuntime,
  type SandboxManagedRuntimeAsset,
  type SandboxManagedRuntimeClient,
  type SandboxRemoteExecutionSpec,
} from "./sandbox-managed-runtime.js";
import { preferredShellForSandbox } from "./sandbox-shell.js";
import { shellQuotePath } from "./shell-path.js";
import type { RunProcessResult } from "./server-utils.js";

export interface CommandManagedRuntimeRunner {
  execute(input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }): Promise<RunProcessResult>;
}

export interface CommandManagedRuntimeSpec {
  providerKey?: string | null;
  shellCommand?: "bash" | "sh" | null;
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
}

export type CommandManagedRuntimeAsset = SandboxManagedRuntimeAsset;

function mergeRuntimeExcludes(entries: string[] | undefined): string[] {
  return [...new Set([".paperclip-runtime", ...(entries ?? [])])];
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireSuccessfulResult(result: RunProcessResult, action: string): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? `: ${stderr}` : "";
  throw new Error(`${action} failed with exit code ${result.exitCode ?? "null"}${detail}`);
}

export function createCommandManagedRuntimeClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs: number;
  shellCommand?: "bash" | "sh" | null;
}): SandboxManagedRuntimeClient {
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runShell = async (script: string, opts: { stdin?: string; timeoutMs?: number } = {}) => {
    const result = await input.runner.execute({
      command: shellCommand,
      args: ["-lc", script],
      cwd: input.remoteCwd,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? input.timeoutMs,
    });
    requireSuccessfulResult(result, script);
    return result;
  };

  return {
    makeDir: async (remotePath) => {
      await runShell(`mkdir -p ${shellQuotePath(remotePath)}`);
    },
    writeFile: async (remotePath, bytes) => {
      const body = toBuffer(bytes).toString("base64");
      const remoteDir = path.posix.dirname(remotePath);
      const remoteTempPath = `${remotePath}.paperclip-upload.b64`;

      await runShell(
        `mkdir -p ${shellQuotePath(remoteDir)} && rm -f ${shellQuotePath(remoteTempPath)} && : > ${shellQuotePath(remoteTempPath)}`,
      );
      await runShell(`cat > ${shellQuotePath(remoteTempPath)}`, { stdin: body });
      await runShell(
        `base64 -d < ${shellQuotePath(remoteTempPath)} > ${shellQuotePath(remotePath)} && rm -f ${shellQuotePath(remoteTempPath)}`,
      );
    },
    readFile: async (remotePath) => {
      const result = await runShell(`base64 < ${shellQuotePath(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    },
    listFiles: async (remotePath) => {
      const result = await runShell(
        `if [ -d ${shellQuotePath(remotePath)} ]; then ` +
          `for entry in ${shellQuotePath(remotePath)}/*; do ` +
          `[ -f "$entry" ] || continue; ` +
          `basename "$entry"; ` +
          `done; ` +
        `fi`,
      );
      return result.stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    remove: async (remotePath) => {
      const result = await input.runner.execute({
        command: shellCommand,
        args: ["-lc", `rm -rf ${shellQuotePath(remotePath)}`],
        cwd: input.remoteCwd,
        timeoutMs: input.timeoutMs,
      });
      requireSuccessfulResult(result, `remove ${remotePath}`);
    },
    run: async (command, options) => {
      const result = await input.runner.execute({
        command: shellCommand,
        args: ["-lc", command],
        cwd: input.remoteCwd,
        timeoutMs: options.timeoutMs,
      });
      requireSuccessfulResult(result, command);
    },
  };
}

export async function prepareCommandManagedRuntime(input: {
  runner: CommandManagedRuntimeRunner;
  spec: CommandManagedRuntimeSpec;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: CommandManagedRuntimeAsset[];
  installCommand?: string | null;
}): Promise<PreparedSandboxManagedRuntime> {
  const timeoutMs = input.spec.timeoutMs && input.spec.timeoutMs > 0 ? input.spec.timeoutMs : 300_000;
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeSpec: SandboxRemoteExecutionSpec = {
    transport: "sandbox",
    provider: input.spec.providerKey ?? "sandbox",
    sandboxId: input.spec.leaseId ?? "managed",
    remoteCwd: workspaceRemoteDir,
    timeoutMs,
    apiKey: null,
  };
  const client = createCommandManagedRuntimeClient({
    runner: input.runner,
    remoteCwd: workspaceRemoteDir,
    timeoutMs,
    shellCommand: input.spec.shellCommand,
  });
  const shellCommand = preferredShellForSandbox(input.spec.shellCommand);

  if (input.installCommand?.trim()) {
    const result = await input.runner.execute({
      command: shellCommand,
      args: ["-lc", input.installCommand.trim()],
      cwd: workspaceRemoteDir,
      timeoutMs,
    });
    requireSuccessfulResult(result, input.installCommand.trim());
  }

  return await prepareSandboxManagedRuntime({
    spec: runtimeSpec,
    client,
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    workspaceExclude: mergeRuntimeExcludes(input.workspaceExclude),
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
  });
}
