import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  assertPaperclipCallbackBridgeEnabled,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", session_id: "cursor-session-1" }),
      JSON.stringify({ type: "assistant", text: "hello" }),
      JSON.stringify({ type: "result", is_error: false, result: "hello", session_id: "cursor-session-1" }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: agent"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
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
    runSshCommand,
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

describe("cursor remote execution", () => {
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
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-denial-"));
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
      expect(runSshCommand).not.toHaveBeenCalled();
      expect(syncDirectoryToSsh).not.toHaveBeenCalled();
      expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["transport-only direct", { executionTarget: { transport: "sandbox" } }],
    ["misspelled direct kind", { executionTarget: { kind: "remtoe" } }],
    ["malformed legacy", { executionTransport: { remoteExecution: { username: "fixture" } } }],
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
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-invalid-"));
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
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
  });

  it("leaves explicit local execution unaffected by the remote callback gate", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-local-gate-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    assertPaperclipCallbackBridgeEnabled.mockImplementation(() => {
      throw Object.assign(new Error("unexpected remote gate"), { code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED });
    });
    try {
      await expect(execute({
        runId: "run-local-gate",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "agent" },
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

  it("prepares the workspace, syncs Cursor skills, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Cursor Builder",
        adapterType: "cursor",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agent",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
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

    expect(result.sessionParams).toMatchObject({
      sessionId: "cursor-session-1",
      cwd: managedRemoteWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: managedRemoteWorkspace,
      },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/cursor/skills`,
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".cursor/skills"),
      expect.anything(),
    );
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--workspace");
    expect(call?.[2]).toContain(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
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
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("resumes saved Cursor sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Cursor Builder",
        adapterType: "cursor",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "agent",
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

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("session-123");
  });

  it("restores the remote workspace if skills sync fails after workspace prep", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-remote-sync-fail-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("sync failed"));

    await expect(execute({
      runId: "run-sync-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Cursor Builder",
        adapterType: "cursor",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agent",
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
    })).rejects.toThrow("sync failed");

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});
