#!/usr/bin/env node
/**
 * Resolve which pnpm workspace packages a set of changed files touches.
 *
 * The pre-commit hook uses this to scope `typecheck` to the affected slice of the
 * workspace instead of running `pnpm -r typecheck` across all 32 packages. Type errors
 * can surface in a package that *consumes* a changed package, so callers are expected to
 * expand each returned name with pnpm's dependents selector (`...<pkg>`); this script
 * deliberately reports only the directly-touched packages and leaves graph expansion to
 * pnpm, which already owns the dependency graph.
 *
 * Any change to a root-level build input (root package.json, the workspace manifest, the
 * lockfile, a root tsconfig, the vitest config) can alter resolution for every package, so
 * those force a full sweep rather than a scoped run.
 *
 * Usage:
 *   node scripts/affected-workspace-packages.mjs [--json] [file ...]
 *
 * With no file arguments the staged set (`git diff --cached`) is used.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { resolveNativeExecutable } from "./gate-child.mjs";
import { resolvePnpmCli } from "./resolve-pnpm-cli.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { fileURLToPath } from "node:url";

const FULL_SWEEP_PATTERNS = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.config\.[cm]?ts$/,
];

function fail(message) {
  throw new Error(message);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function runCaptured(executable, args, { cwd, env = process.env, logPrefix, spawn = spawnSync } = {}) {
  const result = spawn(executable, args, {
    cwd, env, encoding: "utf8", windowsHide: true, shell: false,
    stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    maxBuffer: 128 * 1024, killSignal: "SIGKILL",
  });
  // Sync buffers are finite; the enclosing native supervisor still owns the tree.
  // Preserve both raw streams privately rather than mixing membership JSON into stdout.
  if (logPrefix) {
    appendFileSync(logPrefix + ".stdout.log", result.stdout ?? "");
    appendFileSync(logPrefix + ".stderr.log", result.stderr ?? "");
  }
  if (result.error || result.status !== 0) {
    throw new Error(`native query failed (exit ${result.status ?? "unknown"}): ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`);
  }
  return result;
}

export function readStagedFiles(options = {}) {
  const git = resolveNativeExecutable("git", { env: options.env ?? process.env });
  const result = runCaptured(git, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], options);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function selectedPnpmCommand(env) {
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe"] : ["pnpm"]) {
      const candidate = path.join(directory, name);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* metadata only */ }
    }
  }
  return undefined;
}

/**
 * Ask pnpm for the authoritative workspace membership. Deriving it from pnpm-workspace.yaml
 * by hand would miss the `!`-prefixed exclusions (sandbox-provider plugins, the orchestration
 * smoke fixture), and filtering on a package pnpm does not know about makes it exit non-zero.
 */
export function listWorkspacePackages(repoRoot, options = {}) {
  const env = options.env ?? process.env;
  const binding = resolvePnpmCli({ repoRoot, selectedCommand: selectedPnpmCommand(env), env });
  const result = runCaptured(process.execPath, [binding.cli, "list", "-r", "--depth", "-1", "--json"], { ...options, cwd: repoRoot, env });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse pnpm list output: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    fail("pnpm list did not return an array.");
  }

  const packages = [];
  for (const entry of parsed) {
    if (!entry?.name || !entry?.path) continue;
    const relative = toPosix(path.relative(repoRoot, entry.path));
    // The root manifest is reported with an empty relative path; it would prefix-match every
    // file and collapse the whole computation to "everything is affected".
    if (!relative || relative.startsWith("..")) continue;
    packages.push({ name: entry.name, relativePath: relative });
  }
  // Longest path first so `packages/adapters/codex-local` wins over any shorter prefix.
  packages.sort((a, b) => b.relativePath.length - a.relativePath.length);
  return packages;
}

function matchPackage(packages, file) {
  return packages.find(
    (pkg) => file === pkg.relativePath || file.startsWith(`${pkg.relativePath}/`),
  );
}

export function affectedPayload(changed, packages, fullSweepTrigger = null) {
  const affected = new Set();
  const unmatched = [];
  if (!fullSweepTrigger) {
    for (const file of changed) {
      const pkg = matchPackage(packages, file);
      if (pkg) affected.add(pkg.name);
      // Files outside every workspace package (scripts/, docs/, .github/) cannot change any
      // package's type surface, so they contribute nothing rather than forcing a full sweep.
      else unmatched.push(file);
    }
  }

  const payload = {
    fullSweep: Boolean(fullSweepTrigger),
    fullSweepReason: fullSweepTrigger ? `root build input changed: ${fullSweepTrigger}` : null,
    changedFileCount: changed.length,
    packages: [...affected].sort(),
    unmatchedFiles: unmatched,
  };

  return payload;
}

export function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const git = resolveNativeExecutable("git");
  const identity = runCaptured(git, ["rev-parse", "--show-toplevel"], { cwd: repoRoot });
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(realpathSync(identity.stdout.trim())) !== normalize(realpathSync(repoRoot))) throw new Error("Git root does not match the affected-workspace source root");
  const logResult = runCaptured(git, ["rev-parse", "--git-path", "paperclip-gate-logs/pre-commit"], { cwd: repoRoot });
  const logPath = logResult.stdout.trim();
  if (!logPath || /[\r\n]/u.test(logPath)) throw new Error("Git-private query log path is invalid");
  const logDirectory = path.resolve(repoRoot, logPath);
  mkdirSync(logDirectory, { recursive: true });
  const options = { cwd: repoRoot, logPrefix: path.join(logDirectory, `affected-${Date.now()}-${process.pid}`) };
  appendFileSync(options.logPrefix + ".stdout.log", identity.stdout + logResult.stdout);
  appendFileSync(options.logPrefix + ".stderr.log", (identity.stderr ?? "") + (logResult.stderr ?? ""));
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const files = argv.filter((arg) => !arg.startsWith("--"));
  const changed = files.length > 0 ? files.map(toPosix) : readStagedFiles(options).map(toPosix);

  const fullSweepTrigger = changed.find((file) =>
    FULL_SWEEP_PATTERNS.some((pattern) => pattern.test(file)),
  );

  const packages = fullSweepTrigger ? [] : listWorkspacePackages(repoRoot, options);

  const payload = affectedPayload(changed, packages, fullSweepTrigger);

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const name of payload.packages) console.log(name);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) { console.error(`[affected-packages] ${error.message}`); process.exitCode = 1; }
}
