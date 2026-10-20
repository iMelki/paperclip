#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { runGateChild } from "./gate-child.mjs";
import { resolvePwshExecutable } from "./run-pre-push-pwsh.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runPreCommit(selected, {
  repoRoot = root, run = runGateChild, resolveExecutable = resolvePwshExecutable,
  output = process.stdout, errorOutput = process.stderr,
} = {}) {
  // Pre-commit has no Git update protocol: neither worker inherits hook stdin.
  const executable = resolveExecutable(selected);
  const checked = await run(executable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(repoRoot, "scripts", "pre-commit-check.ps1"),
  ], { cwd: repoRoot, output, errorOutput });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) return checked.status ?? 2;
  const doctor = await run(process.execPath, [path.join(repoRoot, "scripts", "run-react-doctor.js")], {
    cwd: repoRoot, output, errorOutput,
  });
  if (doctor.error) throw doctor.error;
  if (doctor.status === 2) {
    console.warn("React Doctor is disabled: the exact local dependency is not pinned; receipt is incomplete.");
    return 0;
  }
  return doctor.status ?? 2;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = await runPreCommit(process.argv[2]); }
  catch (error) { console.error(`pre-commit launch failed: ${error.message}`); process.exitCode = 2; }
}
