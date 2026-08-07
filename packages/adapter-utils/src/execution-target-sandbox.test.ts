import { createServer } from "node:http";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdapterExecutionTargetProcessSessionLaunchAmbiguousError,
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  reconcileAdapterExecutionTargetProcessSessionLaunchTerminal,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetProcessSessionBridge,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import { createSandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import { runChildProcess } from "./server-utils.js";
import { shellQuote } from "./ssh.js";
import { resolveTestScriptSpawn, resolveTestShellCommand } from "./test-shell.js";

const execFileAsync = promisify(execFile);

describe("sandbox adapter execution targets", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createLocalSandboxRunner() {
    let counter = 0;
    return {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
      }) => {
        counter += 1;
        const command = resolveTestShellCommand(input.command);
        return runChildProcess(`sandbox-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        });
      },
    };
  }

  async function readRuntimeTextFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const contents: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        contents.push(...await readRuntimeTextFiles(entryPath));
      } else if (entry.isFile()) {
        contents.push(await readFile(entryPath, "utf8").catch(() => ""));
      }
    }
    return contents;
  }

  function encodeTailTick(stdout: Buffer, stderr: Buffer): string {
    return [
      "__PAPERCLIP_RUN_LOG_STDOUT__",
      stdout.toString("base64"),
      "__PAPERCLIP_RUN_LOG_STDERR__",
      stderr.toString("base64"),
      "__PAPERCLIP_RUN_LOG_END__",
      "",
    ].join("\n");
  }

  async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
  }

  async function runProxyWithInput(command: string, input: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const target = resolveTestScriptSpawn(command);
    const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Deliberately coalesce data and EOF into one turn. The bridge must retain
    // that receipt order even when each remote queue write is asynchronous.
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for process session proxy."));
      }, process.platform === "win32" ? 10_000 : 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timeout);
        // On Windows, descendants can inherit the pipe handles and delay
        // `close` indefinitely even after the proxy exits. Give the parent
        // streams a bounded drain window instead of awaiting close.
        setTimeout(() => resolve(exitCode), process.platform === "win32" ? 1_000 : 0);
      });
    });
    return { stdout, stderr, code };
  }

  function combinedStream(
    events: Array<{ stream: "stdout" | "stderr"; chunk: string }>,
    stream: "stdout" | "stderr",
  ): string {
    return events.filter((event) => event.stream === stream).map((event) => event.chunk).join("");
  }

  it("executes through the provider-neutral runner without a remote spec", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
      runner,
    };

    expect(adapterExecutionTargetToRemoteSpec(target)).toBeNull();

    const result = await runAdapterExecutionTargetProcess("run-1", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(result.stdout).toBe("ok\n");
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "agent-cli",
      args: ["--json"],
      cwd: "/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutMs: 5000,
    }));
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
    });
  });

  it("bridges bidirectional sandbox process sessions through a local ACPX-spawnable proxy", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fake-acp-child.mjs");
    const childReceiptPath = path.join(rootDir, "fake-acp-child.receipt");
    await writeFile(
      childPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "const receiptPath = process.argv[2];",
        "process.stdin.on('data', (chunk) => {",
        "  appendFileSync(receiptPath, 'data:' + chunk.toString());",
        "  process.stdout.write('out:' + chunk.toString());",
        "  process.stderr.write('err:' + chunk.toString());",
        "});",
        "process.stdin.on('end', () => appendFileSync(receiptPath, 'end\\n'));",
      ].join("\n"),
      "utf8",
    );
    const delegate = createLocalSandboxRunner();
    const runnerCalls: Array<Parameters<typeof delegate.execute>[0]> = [];
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        runnerCalls.push(input);
        return delegate.execute(input);
      },
    };
    const launchSecret = "process-session-secret-must-not-enter-command-args";
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath, childReceiptPath],
      cwd: rootDir,
      env: { PAPERCLIP_API_KEY: launchSecret },
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();
    const commandAuditText = JSON.stringify(
      runnerCalls.map((call) => ({ command: call.command, args: call.args, env: call.env })),
    );
    expect(commandAuditText).not.toContain(launchSecret);
    expect(commandAuditText).not.toContain(Buffer.from(launchSecret, "utf8").toString("base64"));
    const launchCall = runnerCalls.find((call) =>
      (call.args ?? []).join("\n").includes("PAPERCLIP_PROCESS_SESSION_REQUEST_PATH="),
    );
    expect(launchCall?.stdin).toContain(launchSecret);

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
      expect(result.code).toBe(0);
      await expect(readFile(childReceiptPath, "utf8")).resolves.toBe("data:hello\nend\n");
      expect(result.stdout).toBe("out:hello\n");
      expect(result.stderr).toBe("err:hello\n");
    } catch (error) {
      const childReceipt = await readFile(childReceiptPath, "utf8").catch(() => "<missing>");
      throw new Error(`${error instanceof Error ? error.message : String(error)}; child receipt=${JSON.stringify(childReceipt)}`);
    } finally {
      await bridge?.stop();
    }
    // stop() must fence the remote wrapper itself, not merely observe the
    // child exit event. An immediate recursive workspace removal is the
    // Windows EBUSY regression proof for leaked cwd/queue handles.
    await rm(rootDir, { recursive: true, force: true });
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("refuses an untrusted provider before resolving or dispatching launch secrets", async () => {
    const execute = vi.fn();
    const resolveEnv = vi.fn(async () => ({ PAPERCLIP_API_KEY: "novita-command-secret" }));

    await expect(
      startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-process-session-untrusted-stdin",
        target: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "novita",
          remoteCwd: "/tmp",
          runner: {
            supportsConfidentialStdin: false,
            execute,
          },
        },
        runtimeRootDir: "/tmp/.paperclip-runtime/acpx",
        adapterKey: "acpx",
        command: "sh",
        args: ["-lc", "exit 0"],
        cwd: "/tmp",
        env: resolveEnv,
        onLog: async () => {},
      }),
    ).rejects.toThrow("does not advertise confidential stdin");

    expect(resolveEnv).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses launch before mutation when provider process-tree custody is unavailable", async () => {
    const execute = vi.fn();
    const resolveEnv = vi.fn(async () => ({ PAPERCLIP_API_KEY: "must-never-dispatch" }));

    await expect(
      startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-process-session-no-tree-custody",
        target: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "unknown-provider",
          remoteCwd: "/tmp",
          runner: {
            supportsConfidentialStdin: true,
            execute,
          },
        },
        runtimeRootDir: "/tmp/.paperclip-runtime/acpx",
        adapterKey: "acpx",
        command: "sh",
        args: ["-lc", "exit 0"],
        cwd: "/tmp",
        env: resolveEnv,
        onLog: async () => {},
        onLaunchState: async () => {
          throw new Error("launch fence must not be acquired");
        },
      }),
    ).rejects.toThrow("does not advertise authoritative process-tree custody");

    expect(resolveEnv).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reconciles a durable terminal receipt after the disposable exit event was consumed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-terminal-receipt-"));
    cleanupDirs.push(rootDir);
    const sessionId = "session-terminal-receipt";
    const launchId = "launch-terminal-receipt";
    const runId = "run-terminal-receipt";
    const adapterKey = "acpx";
    const sessionDir = path.join(rootDir, "process-sessions", sessionId);
    const eventsDir = path.join(sessionDir, "events");
    await mkdir(eventsDir, { recursive: true });

    const liveWrapper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(liveWrapper.pid).toBeGreaterThan(0);
    const wrapperPid = liveWrapper.pid!;
    const launchIdentityPath = path.join(sessionDir, "launch.identity.json");
    const launcherPidPath = path.join(sessionDir, "launcher.pid");
    const wrapperPidPath = path.join(sessionDir, "wrapper.pid");
    const launchAcceptedPath = path.join(sessionDir, "launch.accepted.json");
    const terminalReceiptPath = path.join(sessionDir, "terminal.receipt.json");
    const childClosedPath = path.join(sessionDir, "child.closed");
    const wrapperDonePath = path.join(sessionDir, "wrapper.done");
    const exactIdentity = {
      schemaVersion: 1,
      launchId,
      sessionId,
      runId,
      adapterKey,
      createdAt: new Date().toISOString(),
    };
    await writeFile(launchIdentityPath, `${JSON.stringify(exactIdentity)}\n`, "utf8");
    await writeFile(launcherPidPath, `${wrapperPid}\n`, "utf8");
    await writeFile(wrapperPidPath, `${wrapperPid}\n`, "utf8");
    await writeFile(
      launchAcceptedPath,
      `${JSON.stringify({ schemaVersion: 1, launchId, wrapperPid, childPid: wrapperPid, acceptedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await writeFile(
      terminalReceiptPath,
      `${JSON.stringify({ schemaVersion: 1, launchId, type: "exit", code: 0, signal: null, timestamp: new Date().toISOString() })}\n`,
      "utf8",
    );
    await writeFile(childClosedPath, `${new Date().toISOString()}\n`, "utf8");
    await writeFile(wrapperDonePath, `${new Date().toISOString()}\n`, "utf8");
    const consumedExitEventPath = path.join(eventsDir, "000000000001.json");
    await writeFile(
      consumedExitEventPath,
      `${JSON.stringify({ type: "exit", code: 0, signal: null })}\n`,
      "utf8",
    );
    await rm(consumedExitEventPath, { force: true });

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      environmentId: "environment-terminal-receipt",
      leaseId: "lease-terminal-receipt",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };
    const launchIdentity = {
      launchId,
      sessionId,
      runId,
      adapterKey,
      transport: "sandbox" as const,
      providerKey: target.providerKey ?? null,
      environmentId: target.environmentId ?? null,
      leaseId: target.leaseId ?? null,
      remoteCwd: rootDir,
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

    await expect(
      reconcileAdapterExecutionTargetProcessSessionLaunchTerminal({ target, launchIdentity }),
    ).resolves.toBe(false);

    await writeFile(
      launchIdentityPath,
      `${JSON.stringify({ ...exactIdentity, runId: "different-run" })}\n`,
      "utf8",
    );
    await new Promise<void>((resolve) => {
      if (liveWrapper.exitCode !== null) return resolve();
      liveWrapper.once("exit", () => resolve());
      liveWrapper.kill();
    });
    await expect(
      reconcileAdapterExecutionTargetProcessSessionLaunchTerminal({ target, launchIdentity }),
    ).resolves.toBe(false);

    await writeFile(launchIdentityPath, `${JSON.stringify(exactIdentity)}\n`, "utf8");
    await expect(readdir(eventsDir)).resolves.toEqual([]);
    await expect(
      reconcileAdapterExecutionTargetProcessSessionLaunchTerminal({ target, launchIdentity }),
    ).resolves.toBe(true);
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("never spawns the ACP child when launch-request unlink cannot be checkpointed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-request-unlink-"));
    cleanupDirs.push(rootDir);
    const runtimeRootDir = path.posix.join(rootDir, ".paperclip-runtime", "acpx");
    const remoteScriptPath = path.join(
      runtimeRootDir,
      "process-sessions",
      "paperclip-process-session-remote.mjs",
    );
    const childMarkerPath = path.join(rootDir, "child-spawned.marker");
    const childPath = path.join(rootDir, "must-not-spawn.mjs");
    await writeFile(childPath, `await import('node:fs/promises').then((fs) => fs.writeFile(${JSON.stringify(childMarkerPath)}, 'spawned'));\n`, "utf8");
    const delegate = createLocalSandboxRunner();
    let launchIdentity: {
      sessionDir: string;
      launchAcceptedPath: string;
    } | null = null;
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const commandText = (input.args ?? []).join("\n");
        if (commandText.includes("PAPERCLIP_PROCESS_SESSION_REQUEST_PATH=")) {
          const source = await readFile(remoteScriptPath, "utf8");
          expect(source).toContain('await fs.rm(launchRequestPath, { force: true });');
          expect(source.indexOf('await fs.rm(launchRequestPath, { force: true });'))
            .toBeLessThan(source.indexOf("const child = spawn("));
          await writeFile(
            remoteScriptPath,
            source.replace(
              'await fs.rm(launchRequestPath, { force: true });',
              'throw new Error("injected launch request unlink failure");',
            ),
            "utf8",
          );
        }
        return delegate.execute(input);
      }),
    };
    const launchSecret = "unlink-failure-secret";
    const error = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-request-unlink",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      },
      runtimeRootDir,
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: { PAPERCLIP_API_KEY: launchSecret },
      timeoutSec: 5,
      onLog: async () => {},
      onLaunchState: async (state) => {
        if (state.status === "launching") launchIdentity = state.launchIdentity;
      },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AdapterExecutionTargetProcessSessionLaunchAmbiguousError);
    await expect(readFile(childMarkerPath, "utf8")).rejects.toThrow();
    await expect(readFile(launchIdentity!.launchAcceptedPath, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(launchIdentity!.sessionDir, "launch.request.json"), "utf8"))
      .resolves.toContain(launchSecret);
  }, process.platform === "win32" ? 30_000 : 20_000);

  it("removes secret-bearing session residue after exact not-started reconciliation", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-not-started-"));
    cleanupDirs.push(rootDir);
    const delegate = createLocalSandboxRunner();
    const launchSecret = "verified-not-started-secret";
    let sessionDir: string | null = null;
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const source = input.args?.join("\n") ?? "";
        if (source.includes("PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=")) {
          if (!sessionDir) throw new Error("launch fence did not publish the session directory");
          await mkdir(sessionDir, { recursive: true });
          await writeFile(path.join(sessionDir, "launch.request.json"), launchSecret, "utf8");
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "provider rejected launch before dispatch",
            pid: null,
            startedAt: null,
          };
        }
        if (input.command === "node" && source.includes("PAPERCLIP_PROCESS_SESSION_RECONCILE=")) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: `PAPERCLIP_PROCESS_SESSION_RECONCILE=${JSON.stringify({
              state: "not_started",
              identityPresent: false,
              identityMatches: false,
              launcherPid: null,
              wrapperPid: null,
              acceptedPresent: false,
              acceptedMatches: false,
              launcherAlive: null,
              wrapperAlive: null,
              childClosedPresent: false,
              wrapperDonePresent: false,
              terminalEventPresent: false,
              terminalReceiptPresent: false,
              terminalReceiptMatches: false,
              terminalReceiptComplete: false,
            })}\n`,
            stderr: "",
            pid: null,
            startedAt: null,
          };
        }
        return delegate.execute(input);
      }),
    };

    const error = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-not-started",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        runner,
      },
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: "sh",
      args: ["-lc", "exit 0"],
      cwd: rootDir,
      env: { PAPERCLIP_API_KEY: launchSecret },
      onLog: async () => {},
      onLaunchState: async (state) => {
        if (state.status === "launching") sessionDir = state.launchIdentity.sessionDir;
      },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AdapterExecutionTargetProcessSessionLaunchAmbiguousError);
    expect((error as Error).message).toContain("provider rejected launch before dispatch");
    expect(sessionDir).not.toBeNull();
    await expect(readFile(path.join(sessionDir!, "launch.request.json"), "utf8")).rejects.toThrow();
    expect((await readRuntimeTextFiles(rootDir)).join("\n")).not.toContain(launchSecret);
  });

  it("does not treat direct-child terminal proof as custody of a surviving detached descendant", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-descendant-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "spawn-detached-descendant.mjs");
    const descendantPidPath = path.join(rootDir, "descendant.pid");
    await writeFile(
      childPath,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
        "descendant.unref();",
        "writeFileSync(process.argv[2], String(descendant.pid) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-detached-descendant",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath, descendantPidPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();
    await expect.poll(
      () => readFile(descendantPidPath, "utf8").then((value) => Number(value.trim()), () => 0),
      { timeout: 5_000 },
    ).toBeGreaterThan(0);
    const descendantPid = Number((await readFile(descendantPidPath, "utf8")).trim());
    try {
      await bridge!.stop();
      await expect(bridge!.reconcileTerminal()).resolves.toBe(true);
      expect(bridge!.treeCustody).toBe("unverified");
      expect(() => process.kill(descendantPid, 0)).not.toThrow();
      await expect(readdir(bridge!.launchIdentity.sessionDir)).resolves.toContain("terminal.receipt.json");
    } finally {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("retries private proxy cleanup without replaying completed stop steps", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stop-retry-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(childPath, "process.stdin.resume();\n", "utf8");
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stop-retry",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        runner: createLocalSandboxRunner(),
      },
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    const originalRm = fs.rm.bind(fs);
    let injectedCleanupFailures = 0;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      const targetPath = String(args[0]);
      if (
        injectedCleanupFailures === 0 &&
        targetPath.includes("paperclip-process-session-proxy") &&
        targetPath.includes(".cleanup-")
      ) {
        injectedCleanupFailures += 1;
        throw new Error("injected transient private proxy cleanup failure");
      }
      return originalRm(...args);
    });

    try {
      await expect(bridge!.stop()).rejects.toThrow("injected transient private proxy cleanup failure");
      await expect(bridge!.stop()).resolves.toBeUndefined();
      expect(injectedCleanupFailures).toBe(1);
    } finally {
      rmSpy.mockRestore();
      await bridge?.stop();
    }
  }, process.platform === "win32" ? 30_000 : 20_000);

  it("adopts a durable process-session launch after the transport times out post-acceptance", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-reconcile-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "reconciled-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.on('data', (chunk) => process.stdout.write('reconciled:' + chunk.toString()));",
        "process.stdin.resume();",
      ].join("\n"),
      "utf8",
    );
    const delegate = createLocalSandboxRunner();
    let launchCalls = 0;
    let reconciliationCalls = 0;
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const source = input.args?.join("\n") ?? "";
        if (source.includes("PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=")) {
          launchCalls += 1;
          const accepted = await delegate.execute(input);
          return {
            ...accepted,
            exitCode: null,
            timedOut: true,
            stdout: "",
            stderr: "provider transport timed out after accepting the launch",
          };
        }
        if (input.command === "node" && source.includes("PAPERCLIP_PROCESS_SESSION_RECONCILE=")) {
          reconciliationCalls += 1;
        }
        return delegate.execute(input);
      }),
    };
    const runtimeRootDir = path.posix.join(rootDir, ".paperclip-runtime", "acpx");
    const logs: string[] = [];
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-reconcile",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      },
      runtimeRootDir,
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    expect(bridge).not.toBeNull();
    expect(launchCalls).toBe(1);
    expect(reconciliationCalls).toBe(1);
    expect(logs.join("")).toContain("adopting durable wrapper");

    try {
      const processSessionRoot = path.join(runtimeRootDir, "process-sessions");
      const sessionEntries = (await readdir(processSessionRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory());
      expect(sessionEntries).toHaveLength(1);
      const sessionDir = path.join(processSessionRoot, sessionEntries[0]!.name);
      const identity = JSON.parse(await readFile(path.join(sessionDir, "launch.identity.json"), "utf8"));
      const accepted = JSON.parse(await readFile(path.join(sessionDir, "launch.accepted.json"), "utf8"));
      const launcherPid = Number((await readFile(path.join(sessionDir, "launcher.pid"), "utf8")).trim());
      const wrapperPid = Number((await readFile(path.join(sessionDir, "wrapper.pid"), "utf8")).trim());
      expect(identity).toMatchObject({
        schemaVersion: 1,
        launchId: accepted.launchId,
        runId: "run-process-session-reconcile",
        adapterKey: "acpx",
      });
      expect(accepted).toMatchObject({ schemaVersion: 1, wrapperPid });
      expect(launcherPid).toBeGreaterThan(0);
      expect(wrapperPid).toBeGreaterThan(0);

      const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("reconciled:hello\n");
    } finally {
      await bridge?.stop();
    }
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("never adopts a dead wrapper that crashed after acceptance without spawning a child", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-accepted-crash-"));
    cleanupDirs.push(rootDir);
    const delegate = createLocalSandboxRunner();
    let launchCalls = 0;
    let launchIdentity: {
      launchId: string;
      sessionId: string;
      sessionDir: string;
      eventsDir: string;
      launchIdentityPath: string;
      launcherPidPath: string;
      wrapperPidPath: string;
      launchAcceptedPath: string;
      childClosedPath: string;
      wrapperDonePath: string;
    } | null = null;
    const deadPid = 999_999_999;
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const source = input.args?.join("\n") ?? "";
        if (source.includes("PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=")) {
          launchCalls += 1;
          if (!launchIdentity) throw new Error("launch fence did not publish identity before dispatch");
          await mkdir(launchIdentity.eventsDir, { recursive: true });
          await writeFile(
            launchIdentity.launchIdentityPath,
            JSON.stringify({ schemaVersion: 1, launchId: launchIdentity.launchId }) + "\n",
            "utf8",
          );
          await writeFile(launchIdentity.launcherPidPath, String(deadPid) + "\n", "utf8");
          await writeFile(launchIdentity.wrapperPidPath, String(deadPid) + "\n", "utf8");
          await writeFile(
            launchIdentity.launchAcceptedPath,
            JSON.stringify({
              schemaVersion: 1,
              launchId: launchIdentity.launchId,
              wrapperPid: deadPid,
              acceptedAt: new Date().toISOString(),
            }) + "\n",
            "utf8",
          );
          return {
            exitCode: null,
            signal: null,
            timedOut: true,
            stdout: "",
            stderr: "provider lost the launch response after the wrapper acceptance write",
            pid: null,
            startedAt: null,
          };
        }
        return delegate.execute(input);
      }),
    };

    const error = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-accepted-crash",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "lost-provider",
        environmentId: "environment-1",
        leaseId: "lease-1",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      },
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: ["-e", "throw new Error('must never spawn')"],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      onLaunchState: async (state) => {
        if (state.status === "launching") launchIdentity = state.launchIdentity;
      },
    }).catch((caught) => caught);

    expect(launchCalls).toBe(1);
    expect(error).toBeInstanceOf(AdapterExecutionTargetProcessSessionLaunchAmbiguousError);
    expect(error).toMatchObject({
      code: "ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS",
      retryable: false,
      needsHuman: true,
      acceptedStart: "unknown",
    });
    expect(error.message).toContain("wrapperAlive=false");
    expect(error.message).toContain("terminalReceiptComplete=false");
    expect(await readdir(launchIdentity!.eventsDir)).toEqual([]);
    await expect(readFile(launchIdentity!.childClosedPath, "utf8")).rejects.toThrow();
    await expect(readFile(launchIdentity!.wrapperDonePath, "utf8")).rejects.toThrow();
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("keeps a post-acceptance host proxy setup failure behind the launch reconciliation fence", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-post-accepted-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(
      childPath,
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n',
      "utf8",
    );
    const hostTmpRoot = path.join(rootDir, "host-tmp");
    await mkdir(hostTmpRoot, { recursive: true });
    vi.stubEnv("TMPDIR", hostTmpRoot);
    vi.stubEnv("TMP", hostTmpRoot);
    vi.stubEnv("TEMP", hostTmpRoot);
    let acceptedIdentity: {
      launchId: string;
      sessionDir: string;
      launchAcceptedPath: string;
      wrapperDonePath: string;
    } | null = null;
    const originalWriteFile = fs.writeFile.bind(fs);
    const proxyWrite = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === "paperclip-process-session-proxy.mjs") {
        throw new Error("injected proxy script write failure after listen");
      }
      return originalWriteFile(...args);
    });
    const serverClose = vi.spyOn(net.Server.prototype, "close");
    let serverCloseCallCount = 0;

    let error: unknown;
    try {
      error = await startAdapterExecutionTargetProcessSessionBridge({
        runId: "run-process-session-post-accepted-setup-failure",
        target: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "local-test",
          remoteCwd: rootDir,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        },
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: {},
        timeoutSec: 5,
        onLog: async () => {},
        onLaunchState: async (state) => {
          if (state.status === "accepted") acceptedIdentity = state.launchIdentity;
        },
      }).catch((caught) => caught);
    } finally {
      serverCloseCallCount = serverClose.mock.calls.length;
      proxyWrite.mockRestore();
      serverClose.mockRestore();
    }

    expect(acceptedIdentity).not.toBeNull();
    expect(error).toBeInstanceOf(AdapterExecutionTargetProcessSessionLaunchAmbiguousError);
    expect(error).toMatchObject({
      code: "ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS",
      retryable: false,
      needsHuman: true,
      acceptedStart: "accepted",
      launchIdentity: { launchId: acceptedIdentity!.launchId },
    });
    expect((error as Error).message).toContain("Host proxy setup failed after the remote launch was accepted");
    expect(serverCloseCallCount).toBeGreaterThan(0);
    await expect(readdir(hostTmpRoot)).resolves.toEqual([]);
    await expect(readFile(acceptedIdentity!.launchAcceptedPath, "utf8")).resolves.toContain(
      acceptedIdentity!.launchId,
    );
    await writeFile(
      path.join(acceptedIdentity!.sessionDir, "stdin", "999999999999.json"),
      JSON.stringify({ type: "stdinEnd" }) + "\n",
      "utf8",
    );
    await expect.poll(
      () => readFile(acceptedIdentity!.wrapperDonePath, "utf8").then(() => true, () => false),
      { timeout: 5_000 },
    ).toBe(true);
  }, process.platform === "win32" ? 25_000 : 15_000);

  it("surfaces an ambiguous launch as a typed non-retryable needs-human error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-ambiguous-"));
    cleanupDirs.push(rootDir);
    const delegate = createLocalSandboxRunner();
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const source = input.args?.join("\n") ?? "";
        if (source.includes("PAPERCLIP_PROCESS_SESSION_LAUNCHER_PID=")) {
          return {
            exitCode: null,
            signal: null,
            timedOut: true,
            stdout: "",
            stderr: "launch transport timed out",
            pid: null,
            startedAt: null,
          };
        }
        if (input.command === "node" && source.includes("PAPERCLIP_PROCESS_SESSION_RECONCILE=")) {
          throw new Error("reconciliation transport unavailable");
        }
        return delegate.execute(input);
      }),
    };

    const error = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-ambiguous",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      },
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AdapterExecutionTargetProcessSessionLaunchAmbiguousError);
    expect(error).toMatchObject({
      code: "ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS",
      retryable: false,
      needsHuman: true,
      acceptedStart: "unknown",
    });
    expect(error.message).toContain("do not retry");
    expect(error.launchIdentity).toMatchObject({
      launchId: expect.any(String),
      sessionId: expect.any(String),
      sessionDir: expect.stringContaining("process-sessions"),
    });
  });

  it("preserves the remote process-session queue when wrapper exit cannot be proven", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-preserve-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(childPath, "process.exit(0);\n", "utf8");
    const delegate = createLocalSandboxRunner();
    const runner = {
      supportsConfidentialStdin: true,
      supportsProcessTreeCustody: true,
      reconcileProcessTreeCustody: async () => false,
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const probeSource = input.command === "node" && input.args?.[0] === "-e" ? input.args[1] ?? "" : "";
        if (probeSource.includes("const pids = JSON.parse(process.argv[1])")) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "wrapper still live",
            pid: null,
            startedAt: null,
          };
        }
        return delegate.execute(input);
      }),
    };
    const runtimeRootDir = path.posix.join(rootDir, ".paperclip-runtime", "acpx");
    const logs: string[] = [];
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-preserve",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      },
      runtimeRootDir,
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    await bridge?.stop();

    const processSessionRoot = path.join(runtimeRootDir, "process-sessions");
    const processSessionEntries = await readdir(processSessionRoot, {
      withFileTypes: true,
    });
    const preservedSession = processSessionEntries.find((entry) => entry.isDirectory());
    expect(preservedSession).toBeTruthy();
    await expect(readdir(path.join(processSessionRoot, preservedSession!.name, "stdin"))).resolves.toBeDefined();
    await expect(readdir(path.join(processSessionRoot, preservedSession!.name, "events"))).resolves.toBeDefined();
    expect(logs.join("")).toContain("did not exit within the cleanup grace; preserving");
  }, 15_000);

  it("buffers sandbox process session output until the local proxy connects", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-buffer-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('early-out\\n');",
        "process.stderr.write('early-err\\n');",
        "setTimeout(() => process.exit(0), 20);",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-buffer",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("early-out\n");
      expect(result.stderr).toBe("early-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("delivers full output when the sandbox child exits immediately after writing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-fast-exit-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "instant-exit-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('final-out\\n');",
        "process.stderr.write('final-err\\n');",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-fast-exit",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("final-out\n");
      expect(result.stderr).toBe("final-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("ignores unauthenticated connections to the process session bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-auth-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "guarded-acp-child.mjs");
    await writeFile(childPath, "process.stdout.write('guarded-out\\n');", "utf8");
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-auth",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    let squatter: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      expect(Number.isFinite(port)).toBe(true);

      // An idle local connection must not claim the session or see buffered output.
      const squatterSocket = net.createConnection({ host: "127.0.0.1", port });
      squatter = squatterSocket;
      let squatterReceived = "";
      squatterSocket.setEncoding("utf8");
      squatterSocket.on("data", (chunk: string) => {
        squatterReceived += chunk;
      });
      squatterSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        squatterSocket.once("connect", () => resolve());
        squatterSocket.once("error", reject);
      });

      // A peer presenting the wrong token is disconnected outright.
      const badPeer = net.createConnection({ host: "127.0.0.1", port });
      badPeer.on("error", () => undefined);
      const badPeerClosed = new Promise<void>((resolve) => badPeer.once("close", () => resolve()));
      badPeer.once("connect", () => badPeer.write(`${JSON.stringify({ token: "wrong-token", type: "stdinEnd" })}\n`));
      await badPeerClosed;

      // The authenticated proxy still attaches and receives the buffered output.
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("guarded-out\n");
      expect(squatterReceived).toBe("");
    } finally {
      squatter?.destroy();
      await bridge?.stop();
    }
  });

  it("streams sandbox process session output before the remote child exits", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "streaming-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  if (chunk.includes('ping')) {",
        "    process.stdout.write('delta:ping\\n');",
        "    process.stderr.write('trace:ping\\n');",
        "  }",
        "  if (chunk.includes('finish')) process.exit(0);",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stream",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    const targetCommand = resolveTestScriptSpawn(bridge!.agentCommand);
    const child = spawn(targetCommand.command, targetCommand.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exited = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for streaming process session proxy."));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        exited = true;
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    try {
      child.stdin.write("ping\n");
      await waitForCondition(
        () => stdout.includes("delta:ping\n") && stderr.includes("trace:ping\n"),
        "Timed out waiting for live process session output.",
        3000,
      );
      expect(exited).toBe(false);

      child.stdin.end("finish\n");
      await expect(exitPromise).resolves.toBe(0);
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await exitPromise.catch(() => undefined);
      }
      await bridge?.stop();
    }
  });

  it("applies the remote sandbox fallback when adapter timeoutSec is unset", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    // The sandbox default is a 4h wall-clock backstop matching the recovery
    // watchdog critical threshold (ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);
    // the output-inactivity monitor remains the primary hang detector.
    expect(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC).toBe(4 * 60 * 60);
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 0)).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
    );
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 90)).toBe(90);
    expect(resolveAdapterExecutionTargetTimeoutSec({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: "KEY",
        knownHosts: "host key",
        strictHostKeyChecking: true,
      },
    }, 0)).toBe(0);
    expect(resolveAdapterExecutionTargetTimeoutSec({ kind: "local" }, 0)).toBe(0);
  });

  it("reports which knob produced the resolved timeout", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 90)).toEqual({
      timeoutSec: 90,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
    // Fractional (sub-second) configured timeouts are preserved rather than
    // floored to 0, which would silently mean "no timeout".
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0.01)).toEqual({
      timeoutSec: 0.01,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0.5)).toEqual({
      timeoutSec: 0.5,
      source: "configured",
    });
  });

  it("treats a negative timeoutSec as the explicit no-timeout opt-out, even on sandbox targets", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, -1)).toBe(0);

    // Explicit zero intentionally does NOT opt out: the adapter config UI
    // persists the schema default of 0 for untouched fields, so a stored
    // timeoutSec=0 cannot be read as operator intent. It keeps the sandbox
    // backstop; the documented opt-out is a negative value.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    // Unset behaves like zero.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, undefined)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, undefined)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
  });

  it("formats self-describing timeout errors naming the timer and knob", () => {
    expect(
      formatAdapterExecutionTimeoutErrorMessage({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=14400, sandbox default). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
    expect(
      formatAdapterExecutionTimeoutErrorMessage({ timeoutSec: 1800, source: "configured" }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=1800, configured via adapterConfig.timeoutSec). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
  });

  it("formats the start-of-run timeout log line with the resolved value and source", () => {
    expect(
      formatAdapterExecutionTimeoutStartLogLine({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=14400 (sandbox default; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 900, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=900 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "unlimited" }),
    ).toBe(
      "Adapter execution timeout: none (no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one).",
    );
    // Negative opt-out resolves to { timeoutSec: 0, source: "configured" }.
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one).",
    );
  });

  it("uses the caller timeout override when installing a missing sandbox command", async () => {
    const runner = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "/usr/bin/opencode\n",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      timeoutMs: 300_000,
      runner,
    };

    await ensureAdapterExecutionTargetCommandResolvable(
      "opencode",
      target,
      "/local/workspace",
      {},
      { installCommand: "npm install -g opencode", timeoutSec: 1800 },
    );

    expect(runner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g opencode"],
      timeoutMs: 1_800_000,
    }));
  });

  it("runs shell commands through the same runner", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("strips inherited host identity env before sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");
    vi.stubEnv("TMPDIR", "/var/folders/local/T");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1b", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/host/bin:/usr/bin",
        HOME: "/Users/local",
        TMPDIR: "/var/folders/local/T",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("preserves explicit remote identity env overrides for sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1c", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("treats SSH targets as bridge-only", () => {
    const target = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };

    expect(adapterExecutionTargetUsesPaperclipBridge(target)).toBe(true);
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "paperclip",
      remoteCwd: "/workspace",
    });
  });

  it("uses the provider-declared shell for sandbox helper commands", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "custom-provider",
      shellCommand: "bash",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2b", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("starts a localhost Paperclip bridge for sandbox targets in bridge mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(bridge?.env.PAPERCLIP_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bridge?.env.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");

      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("creates a sandbox run log tail factory when bridge streaming is enabled", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      streamRunLogs: true,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    try {
      expect(bridge?.runLogTail).toBeTruthy();
      expect(combinedStream(logs, "stdout")).toContain("Sandbox run log streaming enabled");

      const wrapped = bridge!.runLogTail!.create().wrapCommand("agent-cli", ["--message", "hello world"]);
      expect(wrapped.command).toBe("sh");
      expect(wrapped.args.join("\n")).toContain("tee -a");
      expect(wrapped.args.join("\n")).toContain("agent-cli");
    } finally {
      await bridge?.stop();
    }
  });

  it("defaults sandbox run log streaming on and honors the explicit opt-out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-default-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const baseTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const defaultBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-default",
      target: baseTarget,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(defaultBridge?.runLogTail).toBeTruthy();
    } finally {
      await defaultBridge?.stop();
    }

    const optOutBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-opt-out",
      target: { ...baseTarget, streamRunLogs: false },
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(optOutBridge?.runLogTail ?? null).toBeNull();
    } finally {
      await optOutBridge?.stop();
    }
  });

  it("tails sandbox run log chunks with byte offsets and dedupes the final batch", async () => {
    const stdoutText = "stdout-abc\n";
    const stderrText = "stderr-xyz\n";
    const stdoutBytes = Buffer.from(stdoutText, "utf8");
    const stderrBytes = Buffer.from(stderrText, "utf8");
    const stdoutOffsets: number[] = [];
    const stderrOffsets: number[] = [];
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        const stderrStart = Math.max(0, (offsets[1] ?? 1) - 1);
        stdoutOffsets.push(stdoutStart + 1);
        stderrOffsets.push(stderrStart + 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(
            stdoutBytes.subarray(stdoutStart, stdoutStart + 4),
            stderrBytes.subarray(stderrStart, stderrStart + 4),
          ),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 4,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });

    await waitForCondition(
      () => combinedStream(events, "stdout") === stdoutText && combinedStream(events, "stderr") === stderrText,
      "run log tail did not stream expected stdout/stderr chunks",
    );

    await tail.finish({ stdout: stdoutText, stderr: stderrText });

    expect(combinedStream(events, "stdout")).toBe(stdoutText);
    expect(combinedStream(events, "stderr")).toBe(stderrText);
    expect(stdoutOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(stderrOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      cwd: "/workspace",
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      timeoutMs: 50,
    }));
  });

  it("emits only the unstreamed final suffix when the tail loop stops early", async () => {
    const finalStdout = "prefix suffix\n";
    const finalBytes = Buffer.from(finalStdout, "utf8");
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: { args?: string[] }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(finalBytes.subarray(stdoutStart, stdoutStart + 7), Buffer.alloc(0)),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 7,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => combinedStream(events, "stdout").length >= 7, "run log tail did not emit prefix");
    await tail.finish({ stdout: finalStdout, stderr: "" });

    expect(combinedStream(events, "stdout")).toBe(finalStdout);
    expect(events.filter((event) => event.stream === "stdout").map((event) => event.chunk).join("|"))
      .toBe("prefix |suffix\n");
  });

  it("delivers the final batch and a warning when run log polling degrades", async () => {
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "tail failed",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      tickTimeoutMs: 50,
      maxConsecutiveFailures: 1,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => runner.execute.mock.calls.length >= 1, "run log tail did not poll before finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tail.finish({ stdout: "final out\n", stderr: "final err\n" });

    expect(combinedStream(events, "stdout")).toBe("final out\n");
    expect(combinedStream(events, "stderr")).toBe(
      "final err\n[paperclip] Run log streaming degraded during the run; remaining output was delivered at completion.\n",
    );
  });

  it("exposes the Paperclip bridge to the sandbox shell surface", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-shell-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge shell test API server to listen on a TCP port.");
    }

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-shell",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      const shellProbe = [
        "const url = `${process.env.PAPERCLIP_API_URL}/api/agents/me`;",
        "fetch(url, { headers: { authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, accept: 'application/json' } })",
        "  .then(async (response) => {",
        "    const body = await response.json();",
        "    process.stdout.write(JSON.stringify({",
        "      status: response.status,",
        "      body,",
        "      bridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE,",
        "    }));",
        "  })",
        "  .catch((error) => {",
        "    console.error(error instanceof Error ? error.stack : String(error));",
        "    process.exit(1);",
        "  });",
      ].join("\n");

      const result = await runAdapterExecutionTargetShellCommand(
        "run-bridge-shell",
        target,
        `${shellQuote(process.execPath)} -e ${shellQuote(shellProbe)}`,
        {
          cwd: remoteCwd,
          env: bridge!.env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: 200,
        body: { ok: true },
        bridgeMode: "queue_v1",
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("real-run-jwt");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runnerCommandText = JSON.stringify(
        runner.execute.mock.calls.map(([call]) => ({
          command: call.command,
          args: call.args,
        })),
      );
      expect(runnerCommandText).not.toContain("real-run-jwt");
      expect(runnerCommandText).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runtimeFiles = (await readRuntimeTextFiles(runtimeRootDir)).join("\n");
      expect(runtimeFiles).not.toContain("real-run-jwt");
      expect(runtimeFiles).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-shell",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("fails loud when sandbox callback capability revocation is not verified", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stop-proof-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });
    const delegate = createLocalSandboxRunner();
    let injectUnverifiedStop = false;
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        const result = await delegate.execute(input);
        const source = input.args?.join("\n") ?? "";
        if (injectUnverifiedStop && source.includes('kill "$pid"')) {
          return { ...result, timedOut: true };
        }
        return result;
      }),
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stop-proof",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd,
        runner,
      },
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });

    injectUnverifiedStop = true;
    await expect(bridge!.stop()).rejects.toThrow(
      "Sandbox callback bridge capability revocation was not verified",
    );
  });

  it("uses the effective adapter timeout when starting the sandbox callback bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-timeout-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const apiServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge timeout test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-timeout",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(runner.execute).toHaveBeenCalled();
      expect(
        runner.execute.mock.calls.some(([input]) => input.timeoutMs === DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000),
      ).toBe(true);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("fails oversized host responses with a 502 before returning them to the sandbox client", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const largeBody = "x".repeat(64);
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
      });
      res.end(largeBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 32,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 32 bytes.",
      });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-limit",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });
});
