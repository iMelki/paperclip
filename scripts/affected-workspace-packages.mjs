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
import { fileURLToPath } from "node:url";

const FULL_SWEEP_PATTERNS = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.config\.[cm]?ts$/,
];

function fail(message) {
  console.error(`[affected-packages] ${message}`);
  process.exit(1);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function readStagedFiles() {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`git diff --cached failed: ${result.stderr?.trim() || "unknown error"}`);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Ask pnpm for the authoritative workspace membership. Deriving it from pnpm-workspace.yaml
 * by hand would miss the `!`-prefixed exclusions (sandbox-provider plugins, the orchestration
 * smoke fixture), and filtering on a package pnpm does not know about makes it exit non-zero.
 */
function listWorkspacePackages(repoRoot) {
  // Node refuses to spawn a .cmd shim without a shell (CVE-2024-27980 mitigation), and passing
  // an args array *with* `shell: true` concatenates argv unescaped (DEP0190). Passing one static
  // command string is the form that is both supported and warning-free; there is no interpolation
  // here, so nothing user-controlled reaches the shell.
  const result =
    process.platform === "win32"
      ? spawnSync("pnpm list -r --depth -1 --json", {
          cwd: repoRoot,
          encoding: "utf8",
          shell: true,
        })
      : spawnSync("pnpm", ["list", "-r", "--depth", "-1", "--json"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
  if (result.error) {
    fail(`could not run pnpm list: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `pnpm list exited ${result.status ?? "null"}: ${result.stderr?.trim() || "no stderr output"}`,
    );
  }
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

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const files = argv.filter((arg) => !arg.startsWith("--"));
  const changed = files.length > 0 ? files.map(toPosix) : readStagedFiles().map(toPosix);

  const fullSweepTrigger = changed.find((file) =>
    FULL_SWEEP_PATTERNS.some((pattern) => pattern.test(file)),
  );

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packages = fullSweepTrigger ? [] : listWorkspacePackages(repoRoot);

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

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const name of payload.packages) console.log(name);
}

main();
