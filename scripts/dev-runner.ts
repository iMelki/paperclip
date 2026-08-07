#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  completeClaimedDevRunnerShutdown,
  flushDevRunnerPendingExit,
  routeDevRunnerChildExit,
  waitForDevRunnerOutcomeBounded,
  type DevRunnerChildOutcome,
} from "./dev-runner-lifecycle.ts";
import { createCapturedOutputBuffer, parseJsonResponseWithLimit } from "./dev-runner-output.ts";
import { collectWatchedSnapshot as collectDevServerWatchedSnapshot, diffSnapshots } from "./dev-runner-snapshot.mjs";
import { createDevServiceIdentity, repoRoot } from "./dev-service-profile.ts";
import { bootstrapDevRunnerWorktreeEnv } from "../server/src/dev-runner-worktree.ts";
import {
  claimDevRunnerGeneration,
  claimDevRunnerLaunchOrAdopt,
  type LocalServiceLaunchClaim,
} from "./dev-runner-registry.ts";

// Keep these values local so the dev runner can boot from the server package's
// tsx context without requiring workspace package resolution first.
const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
type BindMode = (typeof BIND_MODES)[number];

const worktreeEnvBootstrap = bootstrapDevRunnerWorktreeEnv(repoRoot, process.env);
if (worktreeEnvBootstrap.missingEnv) {
  console.error(
    `[paperclip] linked git worktree at ${repoRoot} is missing ${path.relative(repoRoot, worktreeEnvBootstrap.envPath)}. Run \`paperclipai worktree init\` in this worktree before \`pnpm dev\`.`,
  );
  process.exit(1);
}

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const cliArgs = process.argv.slice(3);
const scanIntervalMs = 1500;
const autoRestartPollIntervalMs = 2500;
const restartHealthTimeoutMs = 5_000;
const shutdownChildExitTimeoutMs = 10_000;
const changedPathSampleLimit = 5;
const devServerStatusFilePath = path.join(repoRoot, ".paperclip", "dev-server-status.json");
const devServerRestartRequestFilePath = path.join(repoRoot, ".paperclip", "dev-server-restart-request.json");
const devServerStatusToken = mode === "dev" ? randomUUID() : null;
const devServerStatusTokenHeader = "x-paperclip-dev-server-status-token";

const watchedDirectories = [
  "cli",
  "scripts",
  "server",
  "packages/adapter-utils",
  "packages/adapters",
  "packages/db",
  "packages/skills-catalog",
  "packages/plugins/sdk",
  "packages/shared",
].map((relativePath) => path.join(repoRoot, relativePath));

const watchedFiles = [
  ".env",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
].map((relativePath) => path.join(repoRoot, relativePath));

const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

const ignoredRelativePaths = new Set([
  ".paperclip/dev-server-restart-request.json",
  ".paperclip/dev-server-status.json",
]);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
let bindMode: BindMode | null = null;
let bindHost: string | null = null;
const forwardedArgs: string[] = [];

for (let index = 0; index < cliArgs.length; index += 1) {
  const arg = cliArgs[index];
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  if (arg === "--bind") {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--") || !BIND_MODES.includes(value as BindMode)) {
      console.error(`[paperclip] invalid --bind value. Use one of: ${BIND_MODES.join(", ")}`);
      process.exit(1);
    }
    bindMode = value as BindMode;
    index += 1;
    continue;
  }
  if (arg === "--bind-host") {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--")) {
      console.error("[paperclip] --bind-host requires a value");
      process.exit(1);
    }
    bindHost = value;
    index += 1;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}
if (!bindMode && process.env.npm_config_bind && BIND_MODES.includes(process.env.npm_config_bind as BindMode)) {
  bindMode = process.env.npm_config_bind as BindMode;
}
if (!bindHost && process.env.npm_config_bind_host) {
  bindHost = process.env.npm_config_bind_host;
}
if (bindMode === "custom" && !bindHost) {
  console.error("[paperclip] --bind custom requires --bind-host <host>");
  process.exit(1);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
};

if (mode === "dev") {
  env.PAPERCLIP_DEV_SERVER_STATUS_FILE = devServerStatusFilePath;
  env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = devServerStatusToken ?? "";
  env.PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true";
}

if (mode === "watch") {
  delete env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
  env.PAPERCLIP_MIGRATION_PROMPT ??= "never";
  env.PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true";
}

if (tailscaleAuth || bindMode) {
  const effectiveBind = bindMode ?? "lan";
  if (tailscaleAuth) {
    console.log("[paperclip] note: --tailscale-auth/--authenticated-private are legacy aliases for --bind lan");
  }
  env.PAPERCLIP_BIND = effectiveBind;
  if (bindHost) {
    env.PAPERCLIP_BIND_HOST = bindHost;
  } else {
    delete env.PAPERCLIP_BIND_HOST;
  }
  if (effectiveBind === "loopback" && !tailscaleAuth) {
    delete env.PAPERCLIP_DEPLOYMENT_MODE;
    delete env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
    delete env.PAPERCLIP_AUTH_BASE_URL_MODE;
    console.log("[paperclip] dev mode: local_trusted (bind=loopback)");
  } else {
    env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
    console.log(
      `[paperclip] dev mode: authenticated/private (bind=${effectiveBind}${bindHost ? `:${bindHost}` : ""})`,
    );
  }
} else {
  delete env.PAPERCLIP_BIND;
  delete env.PAPERCLIP_BIND_HOST;
  delete env.PAPERCLIP_DEPLOYMENT_MODE;
  delete env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  delete env.PAPERCLIP_AUTH_BASE_URL_MODE;
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const serverPort = Number.parseInt(env.PORT ?? process.env.PORT ?? "3100", 10) || 3100;
const devService = createDevServiceIdentity({
  mode,
  forwardedArgs,
  networkProfile: tailscaleAuth ? `legacy:${bindMode ?? "lan"}` : (bindMode ?? "default"),
  port: serverPort,
});

const devRunnerLaunchGate = await claimDevRunnerLaunchOrAdopt({
  serviceKey: devService.serviceKey,
  cwd: repoRoot,
  envFingerprint: devService.envFingerprint,
  port: serverPort,
});
const existingRunner = devRunnerLaunchGate.adopted;
if (existingRunner) {
  console.log(
    `[paperclip] ${devService.serviceName} already running (pid ${existingRunner.pid}${typeof existingRunner.metadata?.childPid === "number" ? `, child ${existingRunner.metadata.childPid}` : ""})`,
  );
  process.exit(0);
}
let devRunnerLaunchClaim = devRunnerLaunchGate.launchClaim;

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let previousSnapshot = collectWatchedSnapshot();
let dirtyPaths = new Set<string>();
let pendingMigrations: string[] = [];
let lastChangedAt: string | null = null;
let lastRestartAt: string | null = null;
let scanInFlight = false;
let restartInFlight = false;
let shuttingDown = false;
let childExitWasExpected = false;
let child: ReturnType<typeof spawn> | null = null;
let childExitPromise: Promise<{ code: number; signal: NodeJS.Signals | null }> | null = null;
let pendingWrapperExitAfterRestart: DevRunnerChildOutcome | null = null;
let childGeneration: {
  generationId: string;
  pid: number;
  startedAt: string;
} | null = null;
let childGenerationTransitionClaim: LocalServiceLaunchClaim | null = null;
let restartDeferredGenerationId: string | null = null;
let serverChildEverSpawned = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let autoRestartTimer: ReturnType<typeof setInterval> | null = null;

function toError(error: unknown, context = "Dev runner command failed") {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

process.on("exit", () => {
  // A pre-spawn startup failure has no possible runner descendant. Once spawn
  // occurred, keep either the launch claim or published registry as custody
  // evidence until an authoritative process-tree stop receipt exists.
  if (devRunnerLaunchClaim && !serverChildEverSpawned) {
    try {
      devRunnerLaunchClaim.releaseSync();
      devRunnerLaunchClaim = null;
    } catch (error) {
      process.stderr.write(`[paperclip] Failed to release pre-spawn dev-runner claim: ${String(error)}\n`);
    }
  }
});

function childGenerationMetadata(extra: Record<string, unknown>) {
  return {
    repoRoot,
    mode,
    childPid: childGeneration?.pid ?? child?.pid ?? null,
    childGenerationId: childGeneration?.generationId ?? null,
    childGenerationStartedAt: childGeneration?.startedAt ?? null,
    childProcessGroupId: null,
    url: `http://127.0.0.1:${serverPort}`,
    ...extra,
  };
}

process.on("uncaughtException", async (error) => {
  if (childGeneration) {
    await patchChildGenerationEvidence(childGeneration, {
      processTreeStatus: "termination_unverified_needs_human",
      wrapperExitReason: "uncaught_exception",
    }).catch(() => null);
  }
  const err = toError(error, "Uncaught exception in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  if (childGeneration) {
    await patchChildGenerationEvidence(childGeneration, {
      processTreeStatus: "termination_unverified_needs_human",
      wrapperExitReason: "unhandled_rejection",
    }).catch(() => null);
  }
  const err = toError(reason, "Unhandled promise rejection in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

function formatPendingMigrationSummary(migrations: string[]) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

function exitForSignal(signal: NodeJS.Signals) {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  process.exit(1);
}

function exitForChildOutcome(outcome: {
  code: number;
  signal: NodeJS.Signals | null;
}) {
  if (outcome.signal) {
    exitForSignal(outcome.signal);
    return;
  }
  process.exit(outcome.code);
}

function flushPendingWrapperExitAfterRestart() {
  const transition = flushDevRunnerPendingExit({
    restartInFlight,
    shuttingDown,
    hasChild: child !== null,
    pending: pendingWrapperExitAfterRestart,
  });
  pendingWrapperExitAfterRestart = transition.pending;
  if (transition.exitNow) {
    exitForChildOutcome(transition.exitNow);
  }
}

function finishRestartAttempt() {
  restartInFlight = false;
  flushPendingWrapperExitAfterRestart();
}

function collectWatchedSnapshot() {
  return collectDevServerWatchedSnapshot({
    repoRoot,
    watchedDirectories,
    watchedFiles,
    ignoredDirectoryNames,
    ignoredRelativePaths,
  }) as Map<string, string>;
}

function ensureDevStatusDirectory() {
  mkdirSync(path.dirname(devServerStatusFilePath), { recursive: true });
}

function writeDevServerStatus() {
  if (mode !== "dev") return;

  ensureDevStatusDirectory();
  const changedPaths = [...dirtyPaths].sort();
  writeFileSync(
    devServerStatusFilePath,
    `${JSON.stringify({
      dirty: changedPaths.length > 0 || pendingMigrations.length > 0,
      lastChangedAt,
      changedPathCount: changedPaths.length,
      changedPathsSample: changedPaths.slice(0, changedPathSampleLimit),
      pendingMigrations,
      lastRestartAt,
    }, null, 2)}\n`,
    "utf8",
  );
}

function clearDevServerStatus() {
  if (mode !== "dev") return;
  rmSync(devServerStatusFilePath, { force: true });
  rmSync(devServerRestartRequestFilePath, { force: true });
}

function consumeDevServerRestartRequest() {
  if (mode !== "dev" || !existsSync(devServerRestartRequestFilePath)) return false;
  rmSync(devServerRestartRequestFilePath, { force: true });
  return true;
}

async function updateDevServiceRecord(extra?: Record<string, unknown>) {
  const launchClaim = devRunnerLaunchClaim;
  const generation = childGeneration;
  if (!launchClaim || !generation || launchClaim.generationId !== generation.generationId) {
    throw new Error(
      "Dev runner cannot publish a child generation without its exact launch claim.",
    );
  }
  await launchClaim.publishNextGeneration({
    version: 1,
    serviceKey: devService.serviceKey,
    profileKind: "paperclip-dev",
    serviceName: devService.serviceName,
    command: "dev-runner.ts",
    cwd: repoRoot,
    envFingerprint: devService.envFingerprint,
    port: serverPort,
    url: `http://127.0.0.1:${serverPort}`,
    pid: process.pid,
    processGroupId: null,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: generation.startedAt,
    lastSeenAt: new Date().toISOString(),
    metadata: childGenerationMetadata({
      childPid: generation.pid,
      childGenerationStatus: "running",
      processTreeStatus: "running_tree_unverified",
      ...extra,
    }),
  });
  if (devRunnerLaunchClaim === launchClaim) {
    await launchClaim.release();
    devRunnerLaunchClaim = null;
  }
}

async function runPnpm(args: string[], options: {
  stdio?: "inherit" | ["ignore", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  return await new Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const spawned = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
      shell: process.platform === "win32",
    });

    const stdoutBuffer = createCapturedOutputBuffer();
    const stderrBuffer = createCapturedOutputBuffer();

    if (spawned.stdout) {
      spawned.stdout.on("data", (chunk) => {
        stdoutBuffer.append(chunk);
      });
    }
    if (spawned.stderr) {
      spawned.stderr.on("data", (chunk) => {
        stderrBuffer.append(chunk);
      });
    }

    spawned.on("error", reject);
    spawned.on("exit", (code, signal) => {
      const stdout = stdoutBuffer.finish();
      const stderr = stderrBuffer.finish();
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
      });
    });
  });
}

async function getMigrationStatusPayload() {
  const status = await runPnpm(
    ["--filter", "@paperclipai/db", "exec", "tsx", "src/migration-status.ts", "--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        `[paperclip] Command failed with code ${status.code}: pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json\n`,
    );
    process.exit(status.code);
  }

  try {
    return JSON.parse(status.stdout.trim()) as { status?: string; pendingMigrations?: string[] };
  } catch (error) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        "[paperclip] migration-status returned invalid JSON payload\n",
    );
    throw toError(error, "Unable to parse migration-status JSON output");
  }
}

async function refreshPendingMigrations() {
  const payload = await getMigrationStatusPayload();
  pendingMigrations =
    payload.status === "needsMigrations" && Array.isArray(payload.pendingMigrations)
      ? payload.pendingMigrations.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : [];
  writeDevServerStatus();
  return payload;
}

async function maybePreflightMigrations(options: { interactive?: boolean; autoApply?: boolean; exitOnDecline?: boolean } = {}) {
  const interactive = options.interactive ?? mode === "watch";
  const autoApply = options.autoApply ?? env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true";
  const exitOnDecline = options.exitOnDecline ?? mode === "watch";

  const payload = await refreshPendingMigrations();
  if (payload.status !== "needsMigrations" || pendingMigrations.length === 0) {
    return;
  }

  let shouldApply = autoApply;

  if (!autoApply && interactive) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) {
    if (exitOnDecline) {
      process.stderr.write(
        `[paperclip] Pending migrations detected (${formatPendingMigrationSummary(pendingMigrations)}). Refusing to start watch mode against a stale schema.\n`,
      );
      process.exit(1);
    }
    return;
  }

  const exit = await runPnpm(["db:migrate"], {
    stdio: "inherit",
    env,
    cwd: repoRoot,
  });
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }

  await refreshPendingMigrations();
}

async function buildPluginSdk() {
  console.log("[paperclip] building plugin sdk...");
  const result = await runPnpm(
    ["--filter", "@paperclipai/plugin-sdk", "build"],
    { stdio: "inherit" },
  );
  if (result.signal) {
    exitForSignal(result.signal);
    return;
  }
  if (result.code !== 0) {
    console.error("[paperclip] plugin sdk build failed");
    process.exit(result.code);
  }
}

async function markChildAsCurrent() {
  previousSnapshot = collectWatchedSnapshot();
  dirtyPaths = new Set();
  lastChangedAt = null;
  lastRestartAt = new Date().toISOString();
  await refreshPendingMigrations();
  await updateDevServiceRecord();
}

async function scanForBackendChanges() {
  if (mode !== "dev" || scanInFlight || restartInFlight) return;
  scanInFlight = true;
  try {
    const nextSnapshot = collectWatchedSnapshot();
    const changed = diffSnapshots(previousSnapshot, nextSnapshot);
    previousSnapshot = nextSnapshot;
    if (changed.length === 0) return;

    for (const relativePath of changed) {
      dirtyPaths.add(relativePath);
    }
    lastChangedAt = new Date().toISOString();
    await refreshPendingMigrations();
  } finally {
    scanInFlight = false;
  }
}

async function getDevHealthPayload() {
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/health`, {
    headers: devServerStatusToken ? { [devServerStatusTokenHeader]: devServerStatusToken } : undefined,
    signal: AbortSignal.timeout(restartHealthTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Health request failed (${response.status})`);
  }
  return await parseJsonResponseWithLimit(response);
}

async function waitForChildExit() {
  if (!childExitPromise) {
    return { code: 0, signal: null };
  }
  return await childExitPromise;
}

async function waitForChildExitBounded(timeoutMs = shutdownChildExitTimeoutMs) {
  const pendingExit = childExitPromise;
  if (!pendingExit) {
    return { code: 0, signal: null };
  }
  return await waitForDevRunnerOutcomeBounded({
    pending: pendingExit,
    timeoutMs,
    timeoutError: () => new Error(
      `Dev runner child exit was not observed within ${timeoutMs}ms; the generation claim and process evidence were retained.`,
    ),
  });
}

async function patchChildGenerationEvidence(
  generation: NonNullable<typeof childGeneration>,
  metadata: Record<string, unknown>,
) {
  const retainedClaim = childGenerationTransitionClaim;
  const usesRetainedClaim = retainedClaim?.expectedGenerationId === generation.generationId;
  const evidenceClaim = usesRetainedClaim
    ? retainedClaim
    : await claimDevRunnerGeneration({
      serviceKey: devService.serviceKey,
      expectedGenerationId: generation.generationId,
    });
  let patchError: unknown = null;
  try {
    await evidenceClaim.patchExpectedGeneration({
      metadata: {
        repoRoot,
        mode,
        childPid: generation.pid,
        childGenerationStartedAt: generation.startedAt,
        childProcessGroupId: null,
        url: `http://127.0.0.1:${serverPort}`,
        ...metadata,
      },
    });
  } catch (error) {
    patchError = error;
  } finally {
    if (!usesRetainedClaim) {
      try {
        await evidenceClaim.release();
      } catch (releaseError) {
        if (patchError) {
          throw new AggregateError(
            [patchError, releaseError],
            "Dev runner generation evidence could not be persisted and its exact generation claim could not be released.",
          );
        }
        throw releaseError;
      }
    }
  }
  if (patchError) {
    throw patchError;
  }
}

async function persistChildGenerationExit(
  generation: NonNullable<typeof childGeneration>,
  code: number,
  signal: NodeJS.Signals | null,
) {
  await patchChildGenerationEvidence(generation, {
    childPid: null,
    childGenerationStatus: "exited_unverified",
    processTreeStatus: "termination_unverified_needs_human",
    wrapperExitReason: signal ? `child_signal_${signal}` : `child_exit_${code}`,
  });
}

async function stopChildForRestart() {
  if (!child || !childGeneration) {
    return {
      wholeTreeExitProven: false,
      reason: "child_generation_missing",
    } as const;
  }

  // A direct ChildProcess exit is not an OS-backed whole-process-tree receipt:
  // package-manager wrappers may leave descendants behind and PIDs may be
  // reused. Until launch-time Job Object/pidfd/cgroup custody exists, keep the
  // current child running and fail closed instead of signaling then replacing
  // it under the same durable registry identity.
  return {
    wholeTreeExitProven: false,
    reason: "os_backed_whole_tree_exit_unavailable",
  } as const;
}

async function startServerChild() {
  const launchClaim = devRunnerLaunchClaim;
  if (!launchClaim) {
    throw new Error("Dev runner child spawn requires a fresh exclusive generation claim.");
  }
  await buildPluginSdk();

  const serverScript = mode === "watch" ? "dev:watch" : "dev";
  const spawnedChild = spawn(
    pnpmBin,
    ["--filter", "@paperclipai/server", serverScript, ...forwardedArgs],
    { stdio: "inherit", env, shell: process.platform === "win32" },
  );
  const observedChildOutcome = new Promise<
    | { kind: "exit"; code: number; signal: NodeJS.Signals | null }
    | { kind: "error"; error: Error }
  >((resolve) => {
    // Attach both observers immediately. Even a synchronous custody-write
    // failure cannot leave this exact spawned handle unobserved.
    spawnedChild.once("error", (error) => resolve({ kind: "error", error }));
    spawnedChild.once("exit", (code, signal) => resolve({
      kind: "exit",
      code: code ?? 0,
      signal,
    }));
  });
  if (!spawnedChild.pid) {
    throw new Error("Dev runner child spawn returned no process identity.");
  }
  const generation = {
    generationId: launchClaim.generationId,
    pid: spawnedChild.pid,
    startedAt: new Date().toISOString(),
  };
  // This synchronous exact-inode write and fsync is deliberately the first
  // state transition after spawn and occurs before any post-spawn await.
  const spawnIdentity = {
    pid: generation.pid,
    processGroupId: null,
    startedAt: generation.startedAt,
  };
  child = spawnedChild;
  childGeneration = generation;
  serverChildEverSpawned = true;
  try {
    launchClaim.recordSpawn(spawnIdentity);
  } catch (recordError) {
    const failures: unknown[] = [recordError];
    let retryRecorded = false;
    try {
      // A bounded synchronous retry can recover a transient short write while
      // preserving the same exact inode and spawn tuple.
      launchClaim.recordSpawn(spawnIdentity);
      retryRecorded = true;
    } catch (retryError) {
      failures.push(retryError);
    }
    let signalAccepted = false;
    let signalDisposition = "not_attempted_posix_pid_identity_unfenced";
    if (process.platform === "win32") {
      signalDisposition = "windows_exact_child_handle_root_signal";
      try {
        signalAccepted = spawnedChild.kill("SIGTERM");
      } catch (signalError) {
        failures.push(signalError);
      }
    }
    const timeoutMarker = Symbol("spawn-custody-stop-timeout");
    const boundedOutcome = process.platform === "win32"
      ? await Promise.race([
        observedChildOutcome,
        new Promise<typeof timeoutMarker>((resolve) => {
          setTimeout(() => resolve(timeoutMarker), 1_000).unref();
        }),
      ])
      : timeoutMarker;
    failures.push(new Error(
      `Spawn custody failed for live/unproven child PID ${generation.pid}; retryRecorded=${retryRecorded}; signalDisposition=${signalDisposition}; signalAccepted=${signalAccepted}; observedOutcome=${
        boundedOutcome === timeoutMarker ? "timeout_unverified" : boundedOutcome.kind
      }. The exact launch claim was retained.`,
    ));
    throw new AggregateError(
      failures,
      "Dev runner could not durably record the spawned child and failed closed before registry publication.",
    );
  }

  childExitPromise = (async () => {
    const outcome = await observedChildOutcome;
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    const expected = childExitWasExpected;
    // Registry persistence is part of this promise's settlement. A restart or
    // wrapper exit cannot run ahead of this generation-fenced write.
    await persistChildGenerationExit(generation, outcome.code, outcome.signal);
    if (
      child === spawnedChild
      && childGeneration?.generationId === generation.generationId
    ) {
      childExitWasExpected = false;
      child = null;
      childGeneration = null;
      childExitPromise = null;
    }

    const routedExit = routeDevRunnerChildExit({
      restartInFlight,
      expected,
      shuttingDown,
      outcome,
    });
    if (routedExit.action === "deferred") {
      pendingWrapperExitAfterRestart = {
        code: routedExit.pending.code,
        signal: routedExit.pending.signal,
      };
    } else if (routedExit.exitNow) {
      exitForChildOutcome(routedExit.exitNow);
    }
    return { code: outcome.code, signal: outcome.signal };
  })();
  childExitPromise.catch((error) => {
    const err = toError(error, "Dev runner child exit persistence failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });

  await markChildAsCurrent();
  restartDeferredGenerationId = null;
}

async function maybeAutoRestartChild() {
  if (mode !== "dev" || restartInFlight || !child) return;
  const manualRestartRequested = consumeDevServerRestartRequest();
  if (!manualRestartRequested && dirtyPaths.size === 0 && pendingMigrations.length === 0) return;
  if (
    !manualRestartRequested
    && childGeneration
    && restartDeferredGenerationId === childGeneration.generationId
  ) {
    return;
  }

  restartInFlight = true;
  let health: { devServer?: { enabled?: boolean; autoRestartEnabled?: boolean; activeRunCount?: number } } | null = null;
  try {
    health = await getDevHealthPayload();
  } catch {
    finishRestartAttempt();
    return;
  }

  const devServer = health?.devServer;
  if (!devServer?.enabled) {
    finishRestartAttempt();
    return;
  }
  if (!manualRestartRequested && devServer.autoRestartEnabled !== true) {
    finishRestartAttempt();
    return;
  }
  if (!manualRestartRequested && (devServer.activeRunCount ?? 0) > 0) {
    finishRestartAttempt();
    return;
  }

  let transitionClaim: LocalServiceLaunchClaim | null = null;
  try {
    const generation = childGeneration;
    if (!generation || child?.pid !== generation.pid) {
      throw new Error("Dev runner active child generation changed before restart claim acquisition.");
    }
    transitionClaim = await claimDevRunnerGeneration({
      serviceKey: devService.serviceKey,
      expectedGenerationId: generation.generationId,
    });
    childGenerationTransitionClaim = transitionClaim;
    const stopReceipt = await stopChildForRestart();
    if (!stopReceipt.wholeTreeExitProven) {
      await patchChildGenerationEvidence(generation, {
        childGenerationStatus: "running_restart_deferred",
        processTreeStatus: "restart_deferred_tree_exit_unproven",
        restartDeferralReason: stopReceipt.reason,
      });
      restartDeferredGenerationId = generation.generationId;
      process.stderr.write(
        "[paperclip] Auto-restart deferred: no OS-backed whole-process-tree exit receipt is available; the current child was left running and no replacement was spawned.\n",
      );
      return;
    }
    // Migration commands can spawn their own process tree. Do not start them
    // until the old generation has an OS-backed whole-tree exit receipt. V1's
    // fail-closed stop gate returns above, so an unbounded migration helper can
    // never suppress an already-persisted unexpected child exit.
    await maybePreflightMigrations({
      autoApply: true,
      interactive: false,
      exitOnDecline: false,
    });
    devRunnerLaunchClaim = transitionClaim;
    childGenerationTransitionClaim = null;
    transitionClaim = null;
    await startServerChild();
  } catch (error) {
    const err = toError(error, "Auto-restart failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
  } finally {
    if (transitionClaim) {
      try {
        await transitionClaim.release();
      } catch (error) {
        const err = toError(error, "Auto-restart generation claim release failed");
        process.stderr.write(`${err.stack ?? err.message}\n`);
      }
    }
    if (childGenerationTransitionClaim === transitionClaim) {
      childGenerationTransitionClaim = null;
    }
    finishRestartAttempt();
  }
}

function installDevIntervals() {
  if (mode !== "dev") return;

  scanTimer = setInterval(() => {
    void scanForBackendChanges();
  }, scanIntervalMs);
  autoRestartTimer = setInterval(() => {
    void maybeAutoRestartChild();
  }, autoRestartPollIntervalMs);
}

function clearDevIntervals() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (autoRestartTimer) {
    clearInterval(autoRestartTimer);
    autoRestartTimer = null;
  }
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    throw new Error(
      `Dev runner shutdown is already in progress; repeated ${signal} cannot safely reuse or replace the retained generation claim.`,
    );
  }
  shuttingDown = true;
  clearDevIntervals();
  clearDevServerStatus();

  const generation = childGeneration;
  if (!child || !generation) {
    exitForSignal(signal);
    return;
  }

  const shutdownClaim = await claimDevRunnerGeneration({
    serviceKey: devService.serviceKey,
    expectedGenerationId: generation.generationId,
  });
  childGenerationTransitionClaim = shutdownClaim;
  let exit: Awaited<ReturnType<typeof waitForChildExit>> | null = null;
  try {
    await patchChildGenerationEvidence(generation, {
      processTreeStatus: "signal_requested_tree_unverified",
      wrapperExitReason: `shutdown_${signal}`,
    });
    childExitWasExpected = true;
    exit = await completeClaimedDevRunnerShutdown({
      signalChild: () => {
        const signalAccepted = child.kill(signal);
        if (!signalAccepted) {
          return false;
        }
        return true;
      },
      signalRejectedError: () => new Error(
        `Dev runner child PID ${generation.pid} rejected ${signal}; the generation claim and process evidence were retained.`,
      ),
      waitForExit: async () => {
        exit = await waitForChildExitBounded();
        return exit;
      },
      releaseClaim: async () => {
        await shutdownClaim.release();
      },
    });
    childGenerationTransitionClaim = null;
  } catch (error) {
    // Keep the exact claim when signaling or exit persistence fails. It fences
    // replacement while the old process tree remains unproven.
    throw error;
  }
  if (!exit) {
    process.exit(1);
  }
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    const err = toError(error, "Dev runner SIGINT shutdown failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    const err = toError(error, "Dev runner SIGTERM shutdown failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
});

await maybePreflightMigrations();
await startServerChild();
installDevIntervals();

if (mode === "watch") {
  const exit = await waitForChildExit();
  if (exit.signal) {
    exitForSignal(exit.signal);
  }
  process.exit(exit.code ?? 0);
}
