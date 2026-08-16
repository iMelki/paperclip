import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

export function resolveVitestCli(resolvePackage = require.resolve) {
  const packageJson = resolvePackage("vitest/package.json");
  return path.join(path.dirname(packageJson), "vitest.mjs");
}

/** Launches Vitest without a command shell so Git-controlled test paths remain argv data. */
export function runVitestDirect(
  args,
  {
    cwd,
    env,
    stdio = "inherit",
    spawn = spawnSync,
    resolvePackage = require.resolve,
  } = {},
) {
  return spawn(process.execPath, [resolveVitestCli(resolvePackage), ...args], {
    cwd,
    env,
    stdio,
    windowsHide: true,
    shell: false,
  });
}
