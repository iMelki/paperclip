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

function newestInputMtimeMs(inputPath) {
  if (!fs.existsSync(inputPath)) return 0;
  const inputStats = fs.statSync(inputPath);
  if (!inputStats.isDirectory()) return inputStats.mtimeMs;

  let newest = 0;

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
    }
  }

  visit(inputPath);
  return Math.max(newest, inputStats.mtimeMs);
}

function needsBuild(target) {
  if (!target.outputs.every((output) => fs.existsSync(output))) return true;
  const newestInput = Math.max(...target.inputs.map((input) => newestInputMtimeMs(input)));
  const oldestOutput = Math.min(...target.outputs.map((output) => fs.statSync(output).mtimeMs));
  return newestInput > oldestOutput;
}

function allOutputsCurrent() {
  return buildTargets.every((target) => !needsBuild(target));
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
    if (allOutputsCurrent()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allOutputsCurrent()) {
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
      if (!allOutputsCurrent()) {
        throw new Error("Plugin build dependency lock released before all outputs were created");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (!needsBuild(target)) {
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
