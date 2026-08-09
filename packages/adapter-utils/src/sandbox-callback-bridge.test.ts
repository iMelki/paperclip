import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareCommandManagedRuntime, type CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  discoverSandboxCallbackBridgeCancellationAuthority,
  parseLinuxProcStatStartIdentity,
  parseWindowsCimProcessIdentityFixture,
  rehydrateSandboxCallbackBridgeCancellationController,
  sandboxCallbackBridgeDirectories,
  sandboxCallbackBridgeProcessIdentityMismatch,
  syncRemoteTextFileWithHashSkip,
  syncSandboxCallbackBridgeEntrypoint,
  SandboxCallbackBridgeLaunchAmbiguousError,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";
import { resolveTestShellCommand } from "./test-shell.js";

const execFile = promisify(execFileCallback);

describe("sandbox callback bridge", () => {
  const cleanupDirs: string[] = [];
  const cleanupFns: Array<() => Promise<void>> = [];

  function createExecRunner() {
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }): Promise<RunProcessResult> => {
        const startedAt = new Date().toISOString();
        const env = {
          ...process.env,
          ...input.env,
        };
        const command = resolveTestShellCommand(input.command);
        const args = [...(input.args ?? [])];
        if (
          input.stdin != null &&
          (input.command === "sh" || input.command === "bash") &&
          (args[0] === "-c" || args[0] === "-lc") &&
          typeof args[1] === "string"
        ) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' \"$PAPERCLIP_TEST_STDIN\" | (${args[1]})`;
        }
        try {
          const result = await execFile(command, args, {
            cwd: input.cwd,
            env,
            maxBuffer: 32 * 1024 * 1024,
            timeout: input.timeoutMs,
          });
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
          const err = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number | null;
            signal?: NodeJS.Signals | null;
            killed?: boolean;
          };
          return {
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: err.signal ?? null,
            timedOut: Boolean(err.killed && input.timeoutMs),
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            pid: null,
            startedAt,
          };
        }
      },
    };
  }

  async function waitForJsonFile(directory: string, timeoutMs = 2_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await readdir(directory).catch(() => []);
      const match = entries.find((entry) => entry.endsWith(".json"));
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for a JSON file in ${directory}.`);
  }

  async function waitForBridgeReadiness(
    readyFile: string,
    timeoutMs = 10_000,
  ): Promise<{ pid: number; processIdentity: { instanceNonce: string } }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const readiness = JSON.parse(await readFile(readyFile, "utf8"));
        if (Number.isInteger(readiness.pid) && readiness.processIdentity?.instanceNonce) {
          return readiness;
        }
      } catch {
        // The detached server has not atomically published readiness yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for bridge readiness at ${readyFile}.`);
  }

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
    }
  }

  async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processIsAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for process ${pid} to exit.`);
  }

  it("parses Linux /proc start identity without trusting the parent or comm shape", () => {
    const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
    fields[0] = "S";
    fields[19] = "987654321";
    const stat = `42 (bridge worker ) with spaces) ${fields.join(" ")}`;

    expect(parseLinuxProcStatStartIdentity(stat)).toBe("987654321");
    expect(parseLinuxProcStatStartIdentity("42 malformed")).toBeNull();
    fields[19] = "not-a-tick";
    expect(parseLinuxProcStatStartIdentity(`42 (bridge) ${fields.join(" ")}`)).toBeNull();
  });

  it("rejects malformed Windows CIM birth fixtures and reports field-specific mismatches", () => {
    const fixture = JSON.stringify({
      status: "present",
      pid: 42,
      bootIdentity: "638900000000000000",
      osStartIdentity: "638900000000123456",
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" bridge.mjs --paperclip-bridge-instance-nonce=abc',
    });
    const parsed = parseWindowsCimProcessIdentityFixture(fixture);
    expect(parsed).toMatchObject({ status: "present", pid: 42 });
    expect(parseWindowsCimProcessIdentityFixture('{"status":"absent"}')).toEqual({ status: "absent" });
    expect(parseWindowsCimProcessIdentityFixture('{"status":"present","pid":42}')).toBeNull();

    const expected = {
      schema: "paperclip-sandbox-callback-process/v1" as const,
      platform: "win32" as const,
      pid: 42,
      bootIdentity: "638900000000000000",
      osStartIdentity: "638900000000123456",
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      scriptMarker: "a".repeat(64),
      instanceNonce: "00000000-0000-4000-8000-000000000000",
    };
    expect(sandboxCallbackBridgeProcessIdentityMismatch(expected, {
      ...expected,
      executablePath: "c:/program files/nodejs/node.exe",
    })).toBeNull();
    expect(sandboxCallbackBridgeProcessIdentityMismatch(expected, {
      ...expected,
      osStartIdentity: "638900000000123457",
    })).toBe("osStartIdentity");
  });

  it("stops the accepted native callback pid even when the shell pid receipt is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-missing-pid-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);
    const directories = sandboxCallbackBridgeDirectories(queueDir);

    expect(processIsAlive(bridge.pid)).toBe(true);
    await expect(readFile(directories.readyFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      pid: bridge.pid,
      processIdentity: bridge.processIdentity,
    });
    await rm(directories.pidFile, { force: true });
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(processIsAlive(bridge.pid)).toBe(false);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.readyFile, "utf8")).rejects.toThrow();
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it("does not let an opaque shell pid receipt replace the accepted native process identities", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-mismatched-pid-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let rewroteOpaqueShellPid = false;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const result = await innerRunner.execute(input);
        if (
          input.args?.[1]?.includes("nohup") &&
          input.args[1].includes("PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT") &&
          /\{"pid":\d+\}/.test(result.stdout)
        ) {
          rewroteOpaqueShellPid = true;
          return { ...result, stdout: result.stdout.replace(/\{"pid":\d+\}/, '{"pid":1}') };
        }
        return result;
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);
    const directories = sandboxCallbackBridgeDirectories(queueDir);

    expect(rewroteOpaqueShellPid).toBe(true);
    expect(bridge.pid).not.toBe(1);
    await expect(readFile(directories.pidFile, "utf8")).resolves.toBe(`${bridge.pid}\n`);
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(processIsAlive(bridge.pid)).toBe(false);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.readyFile, "utf8")).rejects.toThrow();
  });

  it("binds a caller-supplied UUID nonce into accepted launch, readiness, and stop authority", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-caller-nonce-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const instanceNonce = "7c42b620-71a2-4c31-9d80-e0d8fb0ab124";
    const bridge = await startSandboxCallbackBridgeServer({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      instanceNonce,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    expect(bridge.processIdentity.instanceNonce).toBe(instanceNonce);
    await expect(readFile(bridge.directories.launchFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      instanceNonce,
      state: "accepted",
      pid: bridge.pid,
      processIdentity: bridge.processIdentity,
    });
    await expect(bridge.stop()).resolves.toBeUndefined();
    await expect(readFile(bridge.directories.cancelAckFile, "utf8")).resolves.toContain(instanceNonce);
  });

  it("keeps a manifest-before-launch restart fenced when no native accepted receipt exists", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-discover-missing-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });

    const discovery = await discoverSandboxCallbackBridgeCancellationAuthority({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      queueDir,
      instanceNonce: "db210d2f-56cd-41be-887d-03b68f5b7cf9",
      timeoutMs: 30_000,
    });

    expect(discovery).toMatchObject({
      status: "accepted_receipt_absent",
      replaySafe: false,
      reason: "launch_receipt_missing",
      scriptMarker: null,
      processIdentity: null,
      cancellationController: null,
    });
    await expect(readdir(queueDir)).rejects.toThrow();
  });

  it("discovers accepted native identity and rehydrates cancellation after pre-event host loss", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-rehydrate-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    let rehydrated: Awaited<ReturnType<typeof rehydrateSandboxCallbackBridgeCancellationController>> | null = null;
    cleanupFns.push(async () => {
      if (rehydrated) await rehydrated.reconcile();
      else await bridge.stop();
    });
    const persistedDirectories = JSON.parse(JSON.stringify(bridge.directories));
    const persistedIdentity = JSON.parse(JSON.stringify(bridge.processIdentity));
    const launchBeforeAdoption = await readFile(bridge.directories.launchFile, "utf8");

    const discovery = await discoverSandboxCallbackBridgeCancellationAuthority({
      runner,
      remoteCwd: remoteWorkspaceDir,
      queueDir: persistedDirectories.rootDir,
      instanceNonce: persistedIdentity.instanceNonce,
      timeoutMs: 30_000,
    });
    expect(discovery.status).toBe("accepted");
    if (discovery.status !== "accepted") throw new Error(`fixture expected accepted discovery, received ${discovery.status}`);
    rehydrated = discovery.cancellationController;

    expect(discovery.replaySafe).toBe(false);
    expect(discovery.scriptMarker).toBe(bridge.processIdentity.scriptMarker);
    expect(discovery.processIdentity).toEqual(bridge.processIdentity);
    expect(Object.isFrozen(rehydrated)).toBe(true);
    expect(Object.isFrozen(rehydrated.directories)).toBe(true);
    expect(Object.isFrozen(rehydrated.acceptedProcessIdentity)).toBe(true);
    expect(rehydrated.acceptedProcessIdentity).toEqual(bridge.processIdentity);
    expect(processIsAlive(bridge.pid)).toBe(true);
    expect(await readFile(bridge.directories.launchFile, "utf8")).toBe(launchBeforeAdoption);

    await expect(rehydrated.cancel()).resolves.toBe("cancelled");
    await waitForProcessExit(bridge.pid);
    await expect(readFile(bridge.directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      phase: "server",
      instanceNonce: bridge.processIdentity.instanceNonce,
      processIdentity: bridge.processIdentity,
    });
    for (const evidencePath of [bridge.directories.readyFile, bridge.directories.pidFile, bridge.directories.cancelFile, bridge.directories.launchFile]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
  });

  it("refuses rehydration when persisted accepted identity conflicts and preserves custody evidence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-rehydrate-conflict-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    const originalLaunch = await readFile(bridge.directories.launchFile, "utf8");
    const conflictingLaunch = `${JSON.stringify({
      ...JSON.parse(originalLaunch),
      processIdentity: {
        ...bridge.processIdentity,
        osStartIdentity: `${bridge.processIdentity.osStartIdentity}-conflict`,
      },
    })}\n`;
    await writeFile(bridge.directories.launchFile, conflictingLaunch, "utf8");
    cleanupFns.push(async () => {
      await writeFile(bridge.directories.launchFile, originalLaunch, "utf8");
      await bridge.stop();
    });

    await expect(rehydrateSandboxCallbackBridgeCancellationController({
      runner,
      remoteCwd: remoteWorkspaceDir,
      directories: bridge.directories,
      instanceNonce: bridge.processIdentity.instanceNonce,
      scriptMarker: bridge.processIdentity.scriptMarker,
      processIdentity: bridge.processIdentity,
      timeoutMs: 30_000,
    })).rejects.toThrow(/accepted launch changed accepted process identity field: osStartIdentity/i);

    const discovery = await discoverSandboxCallbackBridgeCancellationAuthority({
      runner,
      remoteCwd: remoteWorkspaceDir,
      queueDir,
      instanceNonce: bridge.processIdentity.instanceNonce,
      timeoutMs: 30_000,
    });
    expect(discovery).toMatchObject({
      status: "conflict",
      replaySafe: false,
      processIdentity: null,
      cancellationController: null,
    });
    if (discovery.status === "conflict") {
      expect(discovery.reason).toMatch(/accepted process identity field: osStartIdentity/i);
    }

    expect(processIsAlive(bridge.pid)).toBe(true);
    expect(await readFile(bridge.directories.launchFile, "utf8")).toBe(conflictingLaunch);
    await writeFile(bridge.directories.launchFile, originalLaunch, "utf8");
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it("atomically claims duplicate delivery of the identical launch shell and starts exactly one server", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-duplicate-dispatch-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let duplicateLaunchShell = true;
    let duplicateResults: RunProcessResult[] = [];
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        if (duplicateLaunchShell && input.args?.[1]?.includes("nohup")) {
          duplicateLaunchShell = false;
          duplicateResults = await Promise.all([
            innerRunner.execute(input),
            innerRunner.execute(input),
          ]);
          return duplicateResults[0];
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      instanceNonce: "70df58ae-44ce-4d31-ac87-246539e41622",
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    expect(duplicateResults).toHaveLength(2);
    expect(duplicateResults.every((result) => result.exitCode === 0 && !result.timedOut)).toBe(true);
    expect(duplicateResults.filter((result) => result.stdout.includes("PAPERCLIP_CALLBACK_BRIDGE_START=duplicate"))).toHaveLength(1);
    expect(duplicateResults.filter((result) => /\{"pid":\d+\}/.test(result.stdout))).toHaveLength(1);
    expect(processIsAlive(bridge.pid)).toBe(true);
    await expect(readFile(path.join(bridge.directories.dispatchClaimFile, "owner.json"), "utf8")).resolves.toContain(
      bridge.processIdentity.instanceNonce,
    );

    await expect(bridge.stop()).resolves.toBeUndefined();
    await waitForProcessExit(bridge.pid);
    await expect(readFile(path.join(bridge.directories.dispatchClaimFile, "owner.json"), "utf8")).rejects.toThrow();
    for (const evidencePath of [bridge.directories.readyFile, bridge.directories.pidFile, bridge.directories.cancelFile, bridge.directories.launchFile]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
  });

  it("fails closed before dispatch when a claim directory has no owner receipt", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-ownerless-claim-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(directories.dispatchClaimFile, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    await expect(startSandboxCallbackBridgeServer({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      instanceNonce: "c15dc4bf-32b5-4ea9-971e-b3d847f0187c",
      timeoutMs: 30_000,
    })).rejects.toThrow(/claim directory is missing its owner receipt/i);
    await expect(readFile(directories.readyFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.launchFile, "utf8")).rejects.toThrow();
  });

  it("accepts ppid 1 as diagnostic readiness and never makes it stop authority", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-ppid-one-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const result = await innerRunner.execute(input);
        if (
          result.exitCode === 0 &&
          input.args?.[1]?.includes("Timed out waiting for bridge readiness")
        ) {
          const readiness = JSON.parse(result.stdout);
          return { ...result, stdout: JSON.stringify({ ...readiness, ppid: 1 }) };
        }
        return result;
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    expect(bridge.parentPid).toBe(1);
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(processIsAlive(bridge.pid)).toBe(false);
  });

  it("nonce-cancels a live server when post-start process identity validation fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-readiness-cancel-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let acceptedNativePid = 0;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const result = await innerRunner.execute(input);
        if (
          result.exitCode === 0 &&
          input.args?.[1]?.includes("Timed out waiting for bridge readiness")
        ) {
          const readiness = JSON.parse(result.stdout);
          acceptedNativePid = readiness.pid;
          return {
            ...result,
            stdout: JSON.stringify({
              ...readiness,
              processIdentity: {
                ...readiness.processIdentity,
                instanceNonce: "00000000-0000-4000-8000-000000000000",
              },
            }),
          };
        }
        return result;
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    })).rejects.toThrow(/did not match its launch markers/i);

    expect(acceptedNativePid).toBeGreaterThan(0);
    expect(processIsAlive(acceptedNativePid)).toBe(false);
    await expect(readFile(directories.readyFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.cancelFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      schema: "paperclip-sandbox-callback-cancelled/v1",
      phase: "server",
      processIdentity: { pid: acceptedNativePid },
    });
  });

  it.each(["throws", "times_out"] as const)(
    "nonce-cancels an accepted child when the start transport %s after launch",
    async (failureMode) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), `paperclip-bridge-start-${failureMode}-`));
      cleanupDirs.push(rootDir);
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
      const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
      const directories = sandboxCallbackBridgeDirectories(queueDir);
      await mkdir(remoteWorkspaceDir, { recursive: true });
      const innerRunner = createExecRunner();
      let acceptedNativePid = 0;
      const runner = {
        execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
          const isStartCommand = input.args?.[1]?.includes("nohup") &&
            input.args[1].includes("PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT");
          if (!isStartCommand) return await innerRunner.execute(input);
          const result = await innerRunner.execute(input);
          const readiness = await waitForBridgeReadiness(directories.readyFile);
          acceptedNativePid = readiness.pid;
          if (failureMode === "throws") {
            throw new Error("fixture transport lost the accepted start result");
          }
          return { ...result, exitCode: null, timedOut: true };
        },
      };
      const bridgeAsset = await createSandboxCallbackBridgeAsset();
      cleanupFns.push(bridgeAsset.cleanup);

      await expect(startSandboxCallbackBridgeServer({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir,
        queueDir,
        bridgeToken: createSandboxCallbackBridgeToken(),
        bridgeAsset,
        timeoutMs: 30_000,
      })).rejects.toThrow(
        failureMode === "throws" ? /transport lost the accepted start result/i : /timed out/i,
      );

      expect(acceptedNativePid).toBeGreaterThan(0);
      expect(processIsAlive(acceptedNativePid)).toBe(false);
      for (const evidencePath of [
        directories.readyFile,
        directories.pidFile,
        directories.launchFile,
        directories.cancelFile,
      ]) {
        await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
      }
      await expect(readFile(directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
        schema: "paperclip-sandbox-callback-cancelled/v1",
        phase: "server",
        processIdentity: { pid: acceptedNativePid },
      });
    },
  );

  it("reconciles an accepted exact birth that exits before readiness without replay or pid signalling", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-early-exit-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const originalAsset = await readFile(bridgeAsset.entrypoint, "utf8");
    const earlyExitAsset = originalAsset.replace(
      "function sleep(ms) {",
      "setTimeout(() => { process.stderr.write('fixture exited after accepted birth receipt\\n'); process.exit(23); }, 250);\nawait new Promise(() => undefined);\n\nfunction sleep(ms) {",
    );
    expect(earlyExitAsset).not.toBe(originalAsset);
    await writeFile(bridgeAsset.entrypoint, earlyExitAsset, "utf8");

    const innerRunner = createExecRunner();
    let failFirstCancellationProof = true;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const source = input.args?.[0] === "-e" ? input.args[1] ?? "" : "";
        if (failFirstCancellationProof && source.includes("nonce cancellation self-cleanup")) {
          failFirstCancellationProof = false;
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "fixture lost the first no-ack reconciliation result",
            pid: null,
            startedAt: new Date().toISOString(),
          };
        }
        return await innerRunner.execute(input);
      },
    };

    let caught: unknown;
    try {
      await startSandboxCallbackBridgeServer({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir,
        queueDir,
        bridgeToken: createSandboxCallbackBridgeToken(),
        bridgeAsset,
        timeoutMs: 30_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxCallbackBridgeLaunchAmbiguousError);
    const ambiguous = caught as SandboxCallbackBridgeLaunchAmbiguousError;
    cleanupFns.push(async () => {
      await ambiguous.cancellationController.reconcile();
    });
    const acceptedLaunch = JSON.parse(await readFile(directories.launchFile, "utf8"));
    expect(acceptedLaunch).toMatchObject({
      state: "accepted",
      instanceNonce: ambiguous.instanceNonce,
      processIdentity: { pid: acceptedLaunch.pid, instanceNonce: ambiguous.instanceNonce },
    });
    await waitForProcessExit(acceptedLaunch.pid);
    await expect(readFile(directories.cancelAckFile, "utf8")).rejects.toThrow();

    await expect(ambiguous.cancellationController.reconcile()).resolves.toBe("cancelled");
    await expect(readFile(directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      instanceNonce: ambiguous.instanceNonce,
      phase: "host-reconciled",
      processIdentity: acceptedLaunch.processIdentity,
    });
    for (const evidencePath of [directories.readyFile, directories.pidFile, directories.cancelFile, directories.launchFile]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
  });

  it("leaves a durable nonce tombstone that cancels a provider launch dispatched after reconciliation times out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-start-delayed-dispatch-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let resolveDelayedStart: (result: RunProcessResult) => void = () => undefined;
    const delayedStart = new Promise<RunProcessResult>((resolve) => {
      resolveDelayedStart = resolve;
    });
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        if (input.args?.[1]?.includes("nohup") && input.args[1].includes("PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT")) {
          setTimeout(() => {
            void innerRunner.execute(input).then(resolveDelayedStart);
          }, 4_250);
          return {
            exitCode: null,
            signal: null,
            timedOut: true,
            stdout: "",
            stderr: "fixture provider dispatch remained queued",
            pid: null,
            startedAt: new Date().toISOString(),
          };
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    let caught: unknown;
    try {
      await startSandboxCallbackBridgeServer({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir,
        queueDir,
        bridgeToken: createSandboxCallbackBridgeToken(),
        bridgeAsset,
        timeoutMs: 4_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxCallbackBridgeLaunchAmbiguousError);
    const ambiguous = caught as SandboxCallbackBridgeLaunchAmbiguousError;
    expect(Object.isFrozen(ambiguous.cancellationController)).toBe(true);
    expect(Object.isFrozen(ambiguous.directories)).toBe(true);
    await expect(readFile(directories.cancelFile, "utf8")).resolves.toContain(ambiguous.instanceNonce);

    const delayedResult = await delayedStart;
    expect(delayedResult.exitCode).toBe(0);
    expect(delayedResult.stdout).toContain("PAPERCLIP_CALLBACK_BRIDGE_START=cancelled");
    await expect(ambiguous.cancellationController.reconcile()).resolves.toBe("cancelled");

    for (const evidencePath of [
      directories.readyFile,
      directories.pidFile,
      directories.launchFile,
      directories.cancelFile,
    ]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
    await expect(readFile(directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      schema: "paperclip-sandbox-callback-cancelled/v1",
      instanceNonce: ambiguous.instanceNonce,
      phase: "prelaunch",
    });
  });

  it("returns immutable retry authority when cancellation fails once, then reconciles without replay", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-start-cancel-fail-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let acceptedNativePid = 0;
    let failCancellationPublish = true;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const source = input.args?.[1] ?? "";
        if (failCancellationPublish && source.includes("writeAtomicCallbackEvidence(input.cancelFile")) {
          failCancellationPublish = false;
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "fixture cancellation transport unavailable",
            pid: null,
            startedAt: new Date().toISOString(),
          };
        }
        const isStartCommand = source.includes("nohup") && source.includes("PAPERCLIP_BRIDGE_PRELAUNCH_GATE_INPUT");
        if (!isStartCommand) return await innerRunner.execute(input);
        const result = await innerRunner.execute(input);
        const readiness = await waitForBridgeReadiness(directories.readyFile);
        acceptedNativePid = readiness.pid;
        return { ...result, exitCode: null, timedOut: true };
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    let caught: unknown;
    try {
      await startSandboxCallbackBridgeServer({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir,
        queueDir,
        bridgeToken: createSandboxCallbackBridgeToken(),
        bridgeAsset,
        timeoutMs: 30_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxCallbackBridgeLaunchAmbiguousError);
    const ambiguous = caught as SandboxCallbackBridgeLaunchAmbiguousError;
    cleanupFns.push(async () => {
      await ambiguous.cancellationController.reconcile();
    });
    expect(ambiguous.message).toMatch(/could not be proven.*evidence and controller authority were preserved/i);
    expect(ambiguous.errors).toHaveLength(2);
    expect(ambiguous.acceptedStart).toBe("unknown");
    expect(ambiguous.acceptedProcessIdentity).toBeNull();
    expect(ambiguous.instanceNonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ambiguous.cancellationController.instanceNonce).toBe(ambiguous.instanceNonce);
    expect(Object.isFrozen(ambiguous.cancellationController)).toBe(true);
    expect(Object.isFrozen(ambiguous.cancellationController.directories)).toBe(true);
    expect(processIsAlive(acceptedNativePid)).toBe(true);
    await expect(readFile(directories.readyFile, "utf8")).resolves.toContain(String(acceptedNativePid));
    await expect(readFile(directories.pidFile, "utf8")).resolves.toMatch(/^\d+\r?\n$/);
    await expect(readFile(directories.launchFile, "utf8")).resolves.toContain('"state":"accepted"');

    await expect(ambiguous.cancellationController.cancel()).resolves.toBe("cancelled");
    expect(processIsAlive(acceptedNativePid)).toBe(false);
    await expect(readFile(directories.readyFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.cancelFile, "utf8")).rejects.toThrow();
    await expect(readFile(directories.cancelAckFile, "utf8")).resolves.toContain(ambiguous.instanceNonce);
  });

  it("ignores a cancellation receipt whose instance nonce does not match", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-cancel-mismatch-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      await rm(bridge.directories.cancelFile, { force: true });
      await bridge.stop();
    });

    await writeFile(bridge.directories.cancelFile, JSON.stringify({
      schema: "paperclip-sandbox-callback-cancel/v1",
      instanceNonce: "00000000-0000-4000-8000-000000000000",
    }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(processIsAlive(bridge.pid)).toBe(true);
    await expect(readFile(bridge.directories.readyFile, "utf8")).resolves.toContain(
      bridge.processIdentity.instanceNonce,
    );
    await expect(bridge.stop()).rejects.toThrow(/belongs to another launch instance/i);
    expect(processIsAlive(bridge.pid)).toBe(true);
    await expect(readFile(bridge.directories.cancelFile, "utf8")).resolves.toContain(
      "00000000-0000-4000-8000-000000000000",
    );

    await rm(bridge.directories.cancelFile, { force: true });
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(processIsAlive(bridge.pid)).toBe(false);
  });

  it("uses nonce-cooperative stop across a birth-probe transition and never signals a bare pid", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-reused-pid-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let injectReusedBirthIdentity = false;
    let transitionProbeExecutions = 0;
    const stopSources: string[] = [];
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        if (
          injectReusedBirthIdentity &&
          input.args?.[0] === "-e" &&
          input.args[1]?.includes("const probe = probeCallbackProcessIdentity(expected.pid);")
        ) {
          const args = [...input.args];
          stopSources.push(args[1]);
          transitionProbeExecutions += 1;
          args[1] = args[1].replace(
            "const probe = probeCallbackProcessIdentity(expected.pid);",
            "const observedProbe = probeCallbackProcessIdentity(expected.pid);\n      const probe = observedProbe.status === 'present' ? { ...observedProbe, identity: { ...observedProbe.identity, osStartIdentity: observedProbe.identity.osStartIdentity + '-reused' } } : observedProbe;",
          );
          return await innerRunner.execute({ ...input, args });
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    expect(Object.isFrozen(bridge.processIdentity)).toBe(true);
    injectReusedBirthIdentity = true;
    await expect(bridge.stop()).resolves.toBeUndefined();
    await waitForProcessExit(bridge.pid);

    expect(transitionProbeExecutions).toBe(1);
    expect(stopSources.join("\n")).not.toContain("process.kill(input.expectedIdentity.pid");
    expect(processIsAlive(bridge.pid)).toBe(false);
    await expect(readFile(bridge.directories.readyFile, "utf8")).rejects.toThrow();
    await expect(readFile(bridge.directories.pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(bridge.directories.cancelAckFile, "utf8")).resolves.toContain(
      bridge.processIdentity.instanceNonce,
    );
  });

  it("ignores a live diagnostic parent and coalesces concurrent/repeated stop into one cooperative cancellation", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-coalesce-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let cancellationPublishExecutions = 0;
    let cancellationProofExecutions = 0;
    const stopSources: string[] = [];
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const source = input.args?.[0] === "-e" ? input.args[1] ?? "" : "";
        if (source.includes("writeAtomicCallbackEvidence(input.cancelFile")) {
          cancellationPublishExecutions += 1;
          stopSources.push(source);
        }
        if (source.includes("nonce cancellation self-cleanup")) {
          cancellationProofExecutions += 1;
          stopSources.push(source);
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      nodeCommand: process.execPath,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    bridge.parentPid = process.pid;
    await Promise.all([bridge.stop(), bridge.stop(), bridge.stop()]);
    await bridge.stop();

    expect(cancellationPublishExecutions).toBe(1);
    expect(cancellationProofExecutions).toBe(1);
    expect(stopSources.join("\n")).not.toContain("process.kill(input.expectedIdentity.pid");
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(bridge.pid)).toBe(false);
  });

  it("fails closed and preserves evidence when birth identity inspection is unavailable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-unavailable-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let forceUnavailable = false;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        if (
          forceUnavailable &&
          input.command === process.execPath &&
          input.args?.[0] === "-e" &&
          input.args[1]?.includes("const probe = probeCallbackProcessIdentity(expected.pid);")
        ) {
          const args = [...input.args];
          args[1] = args[1].replace(
            "const probe = probeCallbackProcessIdentity(expected.pid);",
            "const probe = { status: 'unavailable', reason: 'fixture probe unavailable' };",
          );
          return await innerRunner.execute({ ...input, args });
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      nodeCommand: process.execPath,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      forceUnavailable = false;
      await bridge.stop();
    });
    forceUnavailable = true;

    await expect(bridge.stop()).rejects.toThrow(/fixture probe unavailable/i);
    await waitForProcessExit(bridge.pid);
    expect(processIsAlive(bridge.pid)).toBe(false);
    await expect(readFile(bridge.directories.readyFile, "utf8")).resolves.toContain(String(bridge.pid));
    await expect(readFile(bridge.directories.pidFile, "utf8")).resolves.toBe(`${bridge.pid}\n`);
    await expect(readFile(bridge.directories.cancelFile, "utf8")).resolves.toContain(
      bridge.processIdentity.instanceNonce,
    );
    await expect(readFile(bridge.directories.launchFile, "utf8")).resolves.toContain('"state":"accepted"');
    await expect(readFile(bridge.directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      instanceNonce: bridge.processIdentity.instanceNonce,
      phase: "server",
      processIdentity: bridge.processIdentity,
    });

    forceUnavailable = false;
    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(processIsAlive(bridge.pid)).toBe(false);
    for (const evidencePath of [bridge.directories.readyFile, bridge.directories.pidFile, bridge.directories.cancelFile, bridge.directories.launchFile]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
  });

  it("reuses a durable terminal acknowledgement when the first proof result is lost", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-lost-proof-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let loseFirstProofResult = true;
    let cancellationPublishExecutions = 0;
    let publishesThatFoundAck = 0;
    let cancellationProofExecutions = 0;
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const source = input.args?.[0] === "-e" ? input.args[1] ?? "" : "";
        if (source.includes("writeAtomicCallbackEvidence(input.cancelFile")) {
          cancellationPublishExecutions += 1;
          if (await readFile(directories.cancelAckFile, "utf8").catch(() => null)) {
            publishesThatFoundAck += 1;
          }
        }
        if (source.includes("nonce cancellation self-cleanup")) {
          cancellationProofExecutions += 1;
          const result = await innerRunner.execute(input);
          if (loseFirstProofResult) {
            loseFirstProofResult = false;
            return { ...result, exitCode: null, timedOut: true, stdout: "", stderr: "fixture lost proof result" };
          }
          return result;
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    await expect(bridge.stop()).rejects.toThrow(/timed out/i);
    await waitForProcessExit(bridge.pid);
    const durableAck = await readFile(directories.cancelAckFile, "utf8");
    await expect(readFile(directories.cancelFile, "utf8")).rejects.toThrow();

    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(await readFile(directories.cancelAckFile, "utf8")).toBe(durableAck);
    await expect(readFile(directories.cancelFile, "utf8")).rejects.toThrow();
    expect(cancellationPublishExecutions).toBe(2);
    expect(publishesThatFoundAck).toBe(1);
    expect(cancellationProofExecutions).toBe(2);
  });

  it("retries a server acknowledgement write failure before destructive evidence cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-ack-retry-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const originalAsset = await readFile(bridgeAsset.entrypoint, "utf8");
    const acknowledgementWriteMarker =
      "    writeAtomicCallbackEvidence(cancelAckFile, JSON.stringify(acknowledgement)";
    const retryingAsset = originalAsset.replace(
      acknowledgementWriteMarker,
      "    if (!fsSync.existsSync(cancelAckFile + '.fixture-fail-once')) { fsSync.writeFileSync(cancelAckFile + '.fixture-fail-once', '1'); throw new Error('fixture acknowledgement write failed once'); }\n" +
        acknowledgementWriteMarker,
    );
    expect(retryingAsset).not.toBe(originalAsset);
    await writeFile(bridgeAsset.entrypoint, retryingAsset, "utf8");
    const bridge = await startSandboxCallbackBridgeServer({
      runner: createExecRunner(),
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(bridge.stop);

    await expect(bridge.stop()).resolves.toBeUndefined();
    await waitForProcessExit(bridge.pid);
    await expect(readFile(bridge.directories.cancelAckFile, "utf8").then((body) => JSON.parse(body))).resolves.toMatchObject({
      phase: "server",
      processIdentity: bridge.processIdentity,
    });
    await expect(readFile(bridge.directories.logFile, "utf8")).resolves.toContain(
      "fixture acknowledgement write failed once",
    );
    for (const evidencePath of [bridge.directories.readyFile, bridge.directories.pidFile, bridge.directories.cancelFile, bridge.directories.launchFile]) {
      await expect(readFile(evidencePath, "utf8")).rejects.toThrow();
    }
  });

  it("rejects contradictory same-nonce identities before cleanup and preserves every conflicting receipt", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-identity-conflict-"));
    cleanupDirs.push(rootDir);
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const assetRemoteDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-asset");
    const queueDir = path.posix.join(remoteWorkspaceDir, ".paperclip-runtime", "bridge-queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(remoteWorkspaceDir, { recursive: true });
    const innerRunner = createExecRunner();
    let injectConflict = true;
    let conflictingLaunch = "";
    let conflictingReadiness = "";
    const runner = {
      execute: async (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const source = input.args?.[0] === "-e" ? input.args[1] ?? "" : "";
        if (injectConflict && source.includes("nonce cancellation self-cleanup")) {
          injectConflict = false;
          const deadline = Date.now() + 10_000;
          let acknowledgement: Record<string, any> | null = null;
          while (Date.now() < deadline && !acknowledgement) {
            acknowledgement = await readFile(directories.cancelAckFile, "utf8")
              .then((body) => JSON.parse(body))
              .catch(() => null);
            if (!acknowledgement) await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (!acknowledgement?.processIdentity) throw new Error("fixture did not observe server cancellation acknowledgement");
          const conflictingIdentity = {
            ...acknowledgement.processIdentity,
            osStartIdentity: `${acknowledgement.processIdentity.osStartIdentity}-conflict`,
          };
          conflictingLaunch = `${JSON.stringify({
            schema: "paperclip-sandbox-callback-launch/v1",
            instanceNonce: acknowledgement.instanceNonce,
            scriptMarker: conflictingIdentity.scriptMarker,
            state: "accepted",
            pid: conflictingIdentity.pid,
            processIdentity: conflictingIdentity,
          })}\n`;
          conflictingReadiness = JSON.stringify({
            pid: conflictingIdentity.pid,
            processIdentity: conflictingIdentity,
          });
          await writeFile(directories.launchFile, conflictingLaunch, "utf8");
          await writeFile(directories.readyFile, conflictingReadiness, "utf8");
        }
        return await innerRunner.execute(input);
      },
    };
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: createSandboxCallbackBridgeToken(),
      bridgeAsset,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      await rm(directories.launchFile, { force: true });
      await rm(directories.readyFile, { force: true });
      await bridge.stop();
    });

    await expect(bridge.stop()).rejects.toThrow(/changed accepted process identity field.*osStartIdentity/i);
    await waitForProcessExit(bridge.pid);
    expect(await readFile(directories.launchFile, "utf8")).toBe(conflictingLaunch);
    expect(await readFile(directories.readyFile, "utf8")).toBe(conflictingReadiness);
    await expect(readFile(directories.cancelAckFile, "utf8")).resolves.toContain(
      bridge.processIdentity.instanceNonce,
    );

    await rm(directories.launchFile, { force: true });
    await rm(directories.readyFile, { force: true });
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it("round-trips localhost bridge requests over the sandbox queue without forwarding the bridge token", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-runtime-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge test\n", "utf8");

    const runner = createExecRunner();

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);

    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [
        {
          key: "bridge",
          localDir: bridgeAsset.localDir,
        },
      ],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();
    const seenRequests: Array<{
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      body: string;
    }> = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async (request) =>
        request.path === "/api/agents/me" ? null : `Route not allowed: ${request.method} ${request.path}`,
      handleRequest: async (request) => {
        seenRequests.push({
          method: request.method,
          path: request.path,
          query: request.query,
          headers: request.headers,
          body: request.body,
        });
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"bridge-rev-1"',
            "last-modified": "Tue, 01 Apr 2025 00:00:00 GMT",
          },
          body: JSON.stringify({
            ok: true,
            method: request.method,
            path: request.path,
          }),
        };
      },
    });
    cleanupFns.push(async () => {
      await worker.stop();
    });

    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const okResponse = await fetch(`${bridge.baseUrl}/api/agents/me?view=compact`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        accept: "application/json",
        "if-none-match": '"client-cache-key"',
        "x-paperclip-run-id": "run-bridge-1",
        "x-bridge-debug": "drop-me",
      },
    });
    expect(okResponse.status).toBe(200);
    expect(okResponse.headers.get("content-type")).toContain("application/json");
    expect(okResponse.headers.get("etag")).toBe('"bridge-rev-1"');
    expect(okResponse.headers.get("last-modified")).toBe("Tue, 01 Apr 2025 00:00:00 GMT");
    await expect(okResponse.json()).resolves.toMatchObject({
      ok: true,
      method: "GET",
      path: "/api/agents/me",
    });

    const deniedResponse = await fetch(`${bridge.baseUrl}/api/issues/issue-1`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.json()).resolves.toMatchObject({
      error: "Route not allowed: PATCH /api/issues/issue-1",
    });

    const unauthorizedResponse = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: "Bearer wrong-token",
      },
    });
    expect(unauthorizedResponse.status).toBe(401);
    await expect(unauthorizedResponse.json()).resolves.toMatchObject({
      error: "Invalid bridge token.",
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]).toMatchObject({
      method: "GET",
      path: "/api/agents/me",
      query: "?view=compact",
      body: "",
      headers: {
        accept: "application/json",
        "if-none-match": '"client-cache-key"',
      },
    });
    expect(seenRequests[0]?.headers.authorization).toBeUndefined();
    expect(seenRequests[0]?.headers["x-paperclip-run-id"]).toBeUndefined();

  });

  it("denies non-allowlisted requests by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-default-policy-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    let handled = 0;

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      handleRequest: async () => {
        handled += 1;
        return {
          status: 200,
          body: "should not happen",
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-1.json"),
      `${JSON.stringify({
        id: "req-1",
        method: "DELETE",
        path: "/api/secrets",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await worker.stop({ drainTimeoutMs: 1_000 });

    const response = JSON.parse(
      await readFile(path.posix.join(directories.responsesDir, "req-1.json"), "utf8"),
    ) as { status: number; body: string };
    expect(handled).toBe(0);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "Route not allowed: DELETE /api/secrets",
    });
  });

  it("drains already-queued requests on stop", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-drain-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const processed: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        processed.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          status: 200,
          body: request.id,
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-a.json"),
      `${JSON.stringify({
        id: "req-a",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.posix.join(directories.requestsDir, "req-b.json"),
      `${JSON.stringify({
        id: "req-b",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await worker.stop({ drainTimeoutMs: 1_000 });

    expect(processed).toEqual(["req-a", "req-b"]);
    await expect(readFile(path.posix.join(directories.responsesDir, "req-a.json"), "utf8")).resolves.toContain("\"req-a\"");
    await expect(readFile(path.posix.join(directories.responsesDir, "req-b.json"), "utf8")).resolves.toContain("\"req-b\"");
  });

  it("writes fast 503 responses for queued requests that miss the drain deadline", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-drain-timeout-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const processed: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        processed.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          status: 200,
          body: request.id,
        };
      },
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "req-a.json"),
      `${JSON.stringify({
        id: "req-a",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.posix.join(directories.requestsDir, "req-b.json"),
      `${JSON.stringify({
        id: "req-b",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    for (let attempt = 0; attempt < 50 && processed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await worker.stop({ drainTimeoutMs: 10 });

    expect(processed).toEqual(["req-a"]);
    await expect(readFile(path.posix.join(directories.responsesDir, "req-a.json"), "utf8")).resolves.toContain("\"req-a\"");
    await expect(readFile(path.posix.join(directories.responsesDir, "req-b.json"), "utf8")).resolves.toContain(
      "Bridge worker stopped before request could be handled.",
    );
  });

  it("handles SSH queue polling failures without emitting an unhandled rejection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-ssh-failure-"));
    cleanupDirs.push(rootDir);

    const queueDir = path.posix.join(rootDir, "queue");
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const worker = await startSandboxCallbackBridgeWorker({
        client: {
          makeDir: async () => {},
          listJsonFiles: async () => {
            throw new Error(
              "list /remote/.paperclip-runtime/gemini/paperclip-bridge/queue/requests failed with exit code 255: kex_exchange_identification: read: Connection reset by peer",
            );
          },
          readTextFile: async () => {
            throw new Error("unexpected readTextFile");
          },
          writeTextFile: async () => {
            throw new Error("unexpected writeTextFile");
          },
          rename: async () => {
            throw new Error("unexpected rename");
          },
          remove: async () => {},
        },
        queueDir,
        authorizeRequest: async () => null,
        handleRequest: async () => ({
          status: 200,
          body: "ok",
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await worker.stop();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("serializes remote response writes so stop does not recreate a late orphaned response", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-response-lock-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge response lock test\n", "utf8");

    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();
    const seenRequestIds: string[] = [];

    const worker = await startSandboxCallbackBridgeWorker({
      client: createCommandManagedSandboxCallbackBridgeQueueClient({
        runner,
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      }),
      queueDir,
      authorizeRequest: async () => null,
      handleRequest: async (request) => {
        seenRequestIds.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, id: request.id }),
        };
      },
    });
    cleanupFns.push(async () => {
      await worker.stop();
    });

    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const responsePromise = fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    for (let attempt = 0; attempt < 50 && seenRequestIds.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(seenRequestIds).toHaveLength(1);
    await worker.stop({ drainTimeoutMs: 10 });

    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Bridge worker stopped before request could be handled.",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(readdir(directories.responsesDir)).resolves.toEqual([]);
    await expect(
      readdir(directories.responsesDir).then((entries) =>
        entries.filter((entry) => entry.endsWith(".tmp") || entry.includes(".paperclip-write.lock")),
      ),
    ).resolves.toEqual([]);
  });

  it("rejects non-JSON request bodies and full queues at the bridge server", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-server-guards-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge guard test\n", "utf8");

    const runner = createExecRunner();

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();

    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      maxQueueDepth: 1,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    await writeFile(
      path.posix.join(directories.requestsDir, "existing.json"),
      `${JSON.stringify({
        id: "existing",
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: "",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const queueFullResponse = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });
    expect(queueFullResponse.status).toBe(503);
    await expect(queueFullResponse.json()).resolves.toEqual({
      error: "Bridge request queue is full.",
    });

    await rm(path.posix.join(directories.requestsDir, "existing.json"), { force: true });

    const nonJsonResponse = await fetch(`${bridge.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "content-type": "text/plain",
      },
      body: "not json",
    });
    expect(nonJsonResponse.status).toBe(415);
    await expect(nonJsonResponse.json()).resolves.toEqual({
      error: "Bridge only accepts JSON request bodies.",
    });
  });

  it("returns a 502 when the host response times out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-timeout-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge timeout test\n", "utf8");

    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const bridgeToken = createSandboxCallbackBridgeToken();
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
      responseTimeoutMs: 75,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const response = await fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Timed out waiting for host bridge response.",
    });
  });

  it("returns a 502 for malformed host response files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-malformed-response-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(remoteWorkspaceDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "bridge malformed response test\n", "utf8");

    const runner = createExecRunner();
    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const prepared = await prepareCommandManagedRuntime({
      runner,
      spec: {
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
      },
      adapterKey: "codex",
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "bridge", localDir: bridgeAsset.localDir }],
    });

    const queueDir = path.posix.join(prepared.runtimeRootDir, "paperclip-bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const bridgeToken = createSandboxCallbackBridgeToken();
    const bridge = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: prepared.assetDirs.bridge,
      queueDir,
      bridgeToken,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
      responseTimeoutMs: 1_000,
    });
    cleanupFns.push(async () => {
      await bridge.stop();
    });

    const responsePromise = fetch(`${bridge.baseUrl}/api/agents/me`, {
      headers: {
        authorization: `Bearer ${bridgeToken}`,
      },
    });

    const requestFile = await waitForJsonFile(directories.requestsDir);
    await writeFile(
      path.posix.join(directories.responsesDir, requestFile),
      '{"status":200,"headers":{"content-type":"application/json"},"body"',
      "utf8",
    );

    const response = await responsePromise;
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/JSON|Unexpected|Unterminated/i),
    });
  });

  it("reuses an already-uploaded bridge entrypoint when the remote file hash matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-sync-"));
    cleanupDirs.push(rootDir);

    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const remoteAssetDir = path.posix.join(
      remoteWorkspaceDir,
      ".paperclip-runtime",
      "codex",
      "paperclip-bridge",
      "server",
    );
    await mkdir(remoteWorkspaceDir, { recursive: true });

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const originalSource = await readFile(bridgeAsset.entrypoint, "utf8");
    const expandedSource = `${originalSource}\n// bridge payload padding\n`;
    await writeFile(bridgeAsset.entrypoint, expandedSource, "utf8");

    const runner = createExecRunner();

    const first = await syncSandboxCallbackBridgeEntrypoint({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: remoteAssetDir,
      bridgeAsset,
      timeoutMs: 30_000,
    });
    const second = await syncSandboxCallbackBridgeEntrypoint({
      runner,
      remoteCwd: remoteWorkspaceDir,
      assetRemoteDir: remoteAssetDir,
      bridgeAsset,
      timeoutMs: 30_000,
    });

    expect(first.uploaded).toBe(true);
    expect(second.uploaded).toBe(false);
    await expect(readFile(path.posix.join(remoteAssetDir, "paperclip-bridge-server.mjs"), "utf8")).resolves.toBe(expandedSource);
    await expect(
      readdir(remoteAssetDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-bridge-upload.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("rejects a corrupted bridge entrypoint upload without committing a torn remote file", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-sync-corrupt-"));
    cleanupDirs.push(rootDir);

    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const remoteAssetDir = path.posix.join(
      remoteWorkspaceDir,
      ".paperclip-runtime",
      "codex",
      "paperclip-bridge",
      "server",
    );
    await mkdir(remoteWorkspaceDir, { recursive: true });

    const bridgeAsset = await createSandboxCallbackBridgeAsset();
    cleanupFns.push(bridgeAsset.cleanup);
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }) =>
        await createExecRunner().execute({
          ...input,
          stdin: input.stdin != null ? "" : input.stdin,
        }),
    };

    await expect(
      syncSandboxCallbackBridgeEntrypoint({
        runner,
        remoteCwd: remoteWorkspaceDir,
        assetRemoteDir: remoteAssetDir,
        bridgeAsset,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/sha mismatch/i);

    await expect(readFile(path.posix.join(remoteAssetDir, "paperclip-bridge-server.mjs"), "utf8")).rejects.toThrow();
    await expect(
      readdir(remoteAssetDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-bridge-upload.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  // The process-session remote script is a static, Paperclip-authored `.mjs`
  // written into the sandbox on every bridge start. `syncRemoteTextFileWithHashSkip`
  // (which now backs that write, mirroring the bridge-entrypoint sha256 gate)
  // content-hash-skips it so a warm start where the remote script already matches
  // costs ZERO write execs instead of the prior ~3 (prepare/append/finalize base64
  // upload).
  it("test_process_session_script_skipped_when_remote_hash_matches: warm start with a matching remote hash writes 0 execs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-warm-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");
    const body = "console.log('process session remote script v1');\n";

    let execCount = 0;
    const inner = createExecRunner();
    const runner = {
      execute: async (input: Parameters<typeof inner.execute>[0]) => {
        execCount += 1;
        return inner.execute(input);
      },
    };
    const args = {
      runner,
      remoteCwd: rootDir,
      remoteDir,
      remotePath,
      body,
      label: "Process session remote script",
      action: "sync process session remote script",
      lockDir,
      timeoutMs: 30_000,
    } as const;

    // Cold start: the script is uploaded (single sha-gate exec that writes).
    const first = await syncRemoteTextFileWithHashSkip(args);
    expect(first.uploaded).toBe(true);
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);

    // Warm start: the remote hash matches, so the write is skipped entirely.
    execCount = 0;
    const second = await syncRemoteTextFileWithHashSkip(args);
    expect(second.uploaded).toBe(false);
    // A single hash-gate round-trip that performed 0 writes (down from ~3 execs).
    expect(execCount).toBe(1);
    // sha is still returned on the skip path so callers get a well-formed result.
    expect(second.sha256).toBe(first.sha256);
    // The remote file is unchanged and no upload/partial/lock leftovers remain.
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);
    await expect(
      readdir(remoteDir).then((entries) =>
        entries.filter(
          (entry) =>
            entry.endsWith(".paperclip-upload.b64") ||
            entry.endsWith(".partial") ||
            entry === ".paperclip-process-session-script.lock",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("test_process_session_script_rewritten_on_hash_mismatch: a mismatched remote hash still rewrites the script", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-cold-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");
    const body = "console.log('process session remote script v2');\n";

    // Pre-seed the remote with a DIFFERENT script (a prior/stale build).
    await mkdir(remoteDir, { recursive: true });
    await writeFile(remotePath, "console.log('stale remote script');\n", "utf8");

    const result = await syncRemoteTextFileWithHashSkip({
      runner: createExecRunner(),
      remoteCwd: rootDir,
      remoteDir,
      remotePath,
      body,
      label: "Process session remote script",
      action: "sync process session remote script",
      lockDir,
      timeoutMs: 30_000,
    });

    expect(result.uploaded).toBe(true);
    await expect(readFile(remotePath, "utf8")).resolves.toBe(body);
  });

  it("fails loud when the hash-skip sync exec errors instead of silently re-uploading", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hashskip-fail-"));
    cleanupDirs.push(rootDir);
    const remoteDir = path.join(rootDir, "runtime", "codex", "process-sessions");
    const remotePath = path.posix.join(remoteDir, "paperclip-process-session-remote.mjs");
    const lockDir = path.posix.join(remoteDir, ".paperclip-process-session-script.lock");

    // A runner whose exec fails: the hash-gate cannot be evaluated. The write
    // must surface the failure, never swallow it and re-upload behind a green
    // return value.
    const runner = {
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "hash gate boom",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    };

    await expect(
      syncRemoteTextFileWithHashSkip({
        runner,
        remoteCwd: rootDir,
        remoteDir,
        remotePath,
        body: "console.log('never written');\n",
        label: "Process session remote script",
        action: "sync process session remote script",
        lockDir,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/sync process session remote script/i);

    // Nothing was written to the remote path on the failure path.
    await expect(readFile(remotePath, "utf8")).rejects.toThrow();
  });

  it("permits the documented heartbeat surface and denies unrelated routes", () => {
    const allowed: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/api/agents/me" },
      { method: "GET", path: "/api/agents/me/inbox-lite" },
      { method: "GET", path: "/api/agents/me/inbox/mine" },
      { method: "GET", path: "/api/agents/agent-1" },
      { method: "GET", path: "/api/agents/agent-1/skills" },
      { method: "POST", path: "/api/agents/agent-1/skills/sync" },
      { method: "PATCH", path: "/api/agents/agent-1/instructions-path" },
      { method: "GET", path: "/api/companies/co-1" },
      { method: "GET", path: "/api/companies/co-1/dashboard" },
      { method: "GET", path: "/api/companies/co-1/agents" },
      { method: "GET", path: "/api/companies/co-1/issues" },
      { method: "GET", path: "/api/companies/co-1/projects" },
      { method: "GET", path: "/api/companies/co-1/goals" },
      { method: "GET", path: "/api/companies/co-1/org" },
      { method: "GET", path: "/api/companies/co-1/approvals" },
      { method: "GET", path: "/api/companies/co-1/routines" },
      { method: "GET", path: "/api/companies/co-1/skills" },
      { method: "GET", path: "/api/projects/proj-1" },
      { method: "GET", path: "/api/goals/goal-1" },
      { method: "GET", path: "/api/issues/issue-1" },
      { method: "GET", path: "/api/issues/issue-1/heartbeat-context" },
      { method: "GET", path: "/api/issues/issue-1/comments" },
      { method: "GET", path: "/api/issues/issue-1/comments/c-1" },
      { method: "POST", path: "/api/issues/issue-1/comments" },
      { method: "GET", path: "/api/issues/issue-1/documents" },
      { method: "GET", path: "/api/issues/issue-1/documents/plan" },
      { method: "GET", path: "/api/issues/issue-1/documents/plan/revisions" },
      { method: "PUT", path: "/api/issues/issue-1/documents/plan" },
      { method: "POST", path: "/api/issues/issue-1/checkout" },
      { method: "POST", path: "/api/issues/issue-1/release" },
      { method: "PATCH", path: "/api/issues/issue-1" },
      { method: "GET", path: "/api/issues/issue-1/approvals" },
      { method: "GET", path: "/api/issues/issue-1/work-products" },
      { method: "POST", path: "/api/issues/issue-1/work-products" },
      { method: "PATCH", path: "/api/work-products/wp-1" },
      { method: "GET", path: "/api/issues/issue-1/interactions" },
      { method: "GET", path: "/api/issues/issue-1/interactions/inter-1" },
      { method: "POST", path: "/api/issues/issue-1/interactions" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/accept" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/reject" },
      { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/respond" },
      { method: "POST", path: "/api/companies/co-1/issues" },
      { method: "GET", path: "/api/approvals/ap-1" },
      { method: "GET", path: "/api/approvals/ap-1/issues" },
      { method: "GET", path: "/api/approvals/ap-1/comments" },
      { method: "POST", path: "/api/approvals/ap-1/comments" },
      { method: "POST", path: "/api/companies/co-1/approvals" },
      { method: "GET", path: "/api/execution-workspaces/ws-1" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/start" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/stop" },
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/restart" },
      { method: "GET", path: "/api/routines/r-1" },
      { method: "GET", path: "/api/routines/r-1/runs" },
      { method: "POST", path: "/api/companies/co-1/routines" },
      { method: "PATCH", path: "/api/routines/r-1" },
      { method: "POST", path: "/api/routines/r-1/run" },
      { method: "POST", path: "/api/routines/r-1/triggers" },
      { method: "PATCH", path: "/api/routine-triggers/t-1" },
      { method: "DELETE", path: "/api/routine-triggers/t-1" },
    ];
    for (const request of allowed) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request)).toBeNull();
    }

    const denied: Array<{ method: string; path: string }> = [
      { method: "DELETE", path: "/api/secrets" },
      // Pin the runtime-services regex to start/stop/restart only — anything
      // else (delete, reset, wipe, etc.) must stay denied even if the API
      // grows new actions later.
      { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/delete" },
      { method: "POST", path: "/api/companies/co-1/agents" },
      { method: "POST", path: "/api/agents/agent-1/pause" },
      { method: "POST", path: "/api/agents/agent-1/terminate" },
      { method: "POST", path: "/api/agents/agent-1/keys" },
      { method: "POST", path: "/api/companies/co-1/exports" },
      { method: "POST", path: "/api/companies/co-1/imports/apply" },
      { method: "POST", path: "/api/companies/co-1/archive" },
      { method: "DELETE", path: "/api/issues/issue-1/documents/plan" },
      { method: "DELETE", path: "/api/issues/issue-1/approvals/ap-1" },
      { method: "DELETE", path: "/api/work-products/wp-1" },
      { method: "POST", path: "/api/approvals/ap-1/approve" },
      { method: "POST", path: "/api/approvals/ap-1/reject" },
      { method: "POST", path: "/api/companies/co-1/logo" },
      { method: "GET", path: "/api/companies/co-1/secrets" },
      { method: "PATCH", path: "/api/secrets/secret-1" },
    ];
    for (const request of denied) {
      expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request)).toBe(
        `Route not allowed: ${request.method} ${request.path}`,
      );
    }
  });

  it("marks command-managed bridge operations with the bridge execution channel", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
    });

    await client.makeDir("/workspace/.paperclip-runtime/codex/paperclip-bridge/queue");

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
      },
    }));
  });

  it("publishes command-managed queue files by atomic same-directory rename", async () => {
    const runner = {
      execute: vi.fn(async (_input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
    });
    const queuePath = "/workspace/.paperclip-runtime/acpx/process-sessions/session-1/stdin/000000000001.json";

    await client.writeTextFile(queuePath, '{"type":"stdinEnd"}\n');

    const scripts = runner.execute.mock.calls.map(([input]) => input.args?.[1] ?? "");
    const finalize = scripts.find((script) => script.includes("base64 -d") && script.includes("mv -f"));
    expect(finalize).toBeTruthy();
    expect(finalize).toContain(`${queuePath}.paperclip-upload.tmp`);
    expect(finalize).toContain(`mv -f '${queuePath}.paperclip-upload.tmp' '${queuePath}'`);
    expect(finalize).not.toContain(`> '${queuePath}'`);
  });
});
