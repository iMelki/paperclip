#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tscCliPath = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const lockDir = path.join(rootDir, "node_modules", ".cache", "paperclip-plugin-build-deps.lock");
const lockTimeoutMs = 60_000;
const lockPollMs = 100;

const buildTargets = [
  {
    name: "@paperclipai/shared",
    outputs: [
      path.join(rootDir, "packages/shared/dist/index.js"),
      path.join(rootDir, "packages/shared/dist/index.d.ts"),
    ],
    inputs: [
      path.join(rootDir, "packages/shared/src"),
      path.join(rootDir, "packages/shared/tsconfig.json"),
      path.join(rootDir, "packages/shared/package.json"),
    ],
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    outputs: [
      path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/index.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/types.d.ts"),
    ],
    inputs: [
      path.join(rootDir, "packages/plugins/sdk/src"),
      path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
      path.join(rootDir, "packages/plugins/sdk/package.json"),
    ],
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

function getNewestInputMtimeMs(inputPath) {
  if (!fs.existsSync(inputPath)) {
    return 0;
  }

  const stats = fs.statSync(inputPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
    const entryPath = path.join(inputPath, entry.name);
    newest = Math.max(newest, getNewestInputMtimeMs(entryPath));
  }
  return newest;
}

function targetIsFresh(target) {
  if (!target.outputs.every((output) => fs.existsSync(output))) {
    return false;
  }

  const newestInput = Math.max(...target.inputs.map((input) => getNewestInputMtimeMs(input)));
  const oldestOutput = Math.min(...target.outputs.map((output) => fs.statSync(output).mtimeMs));
  return oldestOutput >= newestInput;
}

function allOutputsAreFresh() {
  return buildTargets.every((target) => targetIsFresh(target));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForLockRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < lockTimeoutMs) {
    if (!fs.existsSync(lockDir)) {
      return;
    }
    if (allOutputsAreFresh()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allOutputsAreFresh()) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(lockDir), { recursive: true });

let holdsLock = false;
let exitCode = 0;
try {
  try {
    fs.mkdirSync(lockDir);
    holdsLock = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      waitForLockRelease();
      if (!allOutputsAreFresh()) {
        throw new Error("Plugin build dependency lock released before all outputs were created");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (targetIsFresh(target)) {
      continue;
    }

    const result = spawnSync(process.execPath, [tscCliPath, "-p", target.tsconfig], {
      cwd: rootDir,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  if (holdsLock) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
