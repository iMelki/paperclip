import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  assertPaperclipCallbackBridgeEnabled,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  assertPaperclipCallbackBridgeEnabled: vi.fn(() => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    assertPaperclipCallbackBridgeEnabled,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute as executeAdapter } from "./execute.js";
import {
  PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
  PAPERCLIP_EXECUTION_TARGET_INVALID,
} from "@paperclipai/adapter-utils/execution-target";

async function execute(ctx: Parameters<typeof executeAdapter>[0]) {
  return await executeAdapter({
    ...ctx,
    onEvent: ctx.onEvent ?? (async () => undefined),
  });
}

describe("claude remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each(["ssh", "sandbox"] as const)(
    "fails closed for a valid %s callback target before any adapter side effect",
    async (transport) => {
      const onLog = vi.fn(async () => undefined);
      const onMeta = vi.fn(async () => undefined);
      const onEvent = vi.fn(async () => undefined);
      const onSpawn = vi.fn(async () => undefined);
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-denial-"));
      cleanupDirs.push(rootDir);
      const sideEffectPath = path.join(rootDir, "must-not-exist");
      const runnerExecute = vi.fn();
      const executionTarget = transport === "ssh"
        ? {
            kind: "remote", transport: "ssh", remoteCwd: "/remote/workspace",
            spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote/workspace" },
          }
        : {
            kind: "remote", transport: "sandbox", providerKey: "fixture",
            remoteCwd: "/remote/workspace", runner: { execute: runnerExecute },
          };
      assertPaperclipCallbackBridgeEnabled.mockImplementationOnce(() => {
        throw Object.assign(new Error("callback bridge disabled"), {
          code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED, retryable: false, needsHuman: true,
        });
      });

      await expect(execute({
        executionTarget,
        config: { cwd: sideEffectPath },
        context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
        onLog, onMeta, onEvent, onSpawn,
      } as never)).rejects.toMatchObject({
        code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED, retryable: false, needsHuman: true,
      });

      expect(onLog).not.toHaveBeenCalled();
      expect(onMeta).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onSpawn).not.toHaveBeenCalled();
      await expect(access(sideEffectPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runnerExecute).not.toHaveBeenCalled();
      expect(ensureCommandResolvable).not.toHaveBeenCalled();
      expect(resolveCommandForLogs).not.toHaveBeenCalled();
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
      expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
      expect(syncDirectoryToSsh).not.toHaveBeenCalled();
      expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["non-object direct", { executionTarget: "remote" }],
    ["missing direct kind", { executionTarget: { transport: "sandbox" } }],
    ["malformed legacy", { executionTransport: { remoteExecution: { host: "127.0.0.1" } } }],
    ["invalid direct cannot hide behind valid legacy", {
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "" },
      executionTransport: { remoteExecution: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote/workspace",
      } },
    }],
  ] as const)("rejects %s target input without local fallback", async (_label, targetInput) => {
    const onLog = vi.fn(async () => undefined);
    const onMeta = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);
    const onSpawn = vi.fn(async () => undefined);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-invalid-"));
    cleanupDirs.push(rootDir);
    const sideEffectPath = path.join(rootDir, "must-not-exist");

    await expect(execute({
      ...targetInput,
      config: { cwd: sideEffectPath },
      context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
      onLog, onMeta, onEvent, onSpawn,
    } as never)).rejects.toMatchObject({
      code: PAPERCLIP_EXECUTION_TARGET_INVALID, retryable: false, needsHuman: true,
    });

    expect(assertPaperclipCallbackBridgeEnabled).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
    expect(onMeta).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    await expect(access(sideEffectPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ensureCommandResolvable).not.toHaveBeenCalled();
    expect(resolveCommandForLogs).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
  });

  it("leaves explicit local execution unaffected by the remote callback gate", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-gate-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    assertPaperclipCallbackBridgeEnabled.mockImplementation(() => {
      throw Object.assign(new Error("unexpected remote gate"), { code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED });
    });
    try {
      await expect(execute({
        runId: "run-local-gate",
        agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "claude" },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        executionTarget: { kind: "local" },
        onLog: async () => undefined,
      } as never)).resolves.toHaveProperty("exitCode");
      expect(assertPaperclipCallbackBridgeEnabled).not.toHaveBeenCalled();
      expect(runChildProcess).toHaveBeenCalled();
    } finally {
      assertPaperclipCallbackBridgeEnabled.mockImplementation(() => undefined);
    }
  });

  it("prepares the workspace, syncs Claude runtime assets, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const instructionsPath = path.join(rootDir, "instructions.md");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the remote workspace.\n", "utf8");

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        env: {
          QA_PROJECT_WORKSPACE_CWD: workspaceDir,
          RANDOM_WORKSPACE_CWD: workspaceDir,
          OTHER_ENV: workspaceDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-claude",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`,
      followSymlinks: true,
    }));
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--allowedTools");
    expect(call?.[2]).toContain(
      "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write",
    );
    expect(call?.[2]).not.toContain("--dangerously-skip-permissions");
    expect(call?.[2]).toContain("--append-system-prompt-file");
    expect(call?.[2]).toContain(
      `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills/agent-instructions.md`,
    );
    expect(call?.[2]).toContain("--add-dir");
    expect(call?.[2]).toContain(`${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.QA_PROJECT_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.RANDOM_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.OTHER_ENV).toBe(workspaceDir);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("does not resume saved Claude sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
  });

  it("resumes saved Claude sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("12345678-1234-4abc-9def-123456789012");
  });

});
