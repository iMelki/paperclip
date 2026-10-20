import { runGateChild } from "./gate-child.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

export function resolveVitestCli(
  resolvePackage = require.resolve,
  readManifest = readFileSync,
) {
  const packageJson = resolvePackage("vitest/package.json");
  const manifest = JSON.parse(readManifest(packageJson, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (typeof bin !== "string" || bin.trim() === "") {
    throw new Error("the resolved Vitest package manifest does not declare a vitest executable");
  }
  const packageRoot = path.dirname(packageJson);
  const cliPath = path.resolve(packageRoot, bin);
  const relativeCliPath = path.relative(packageRoot, cliPath);
  if (
    relativeCliPath === "" ||
    relativeCliPath === ".." ||
    relativeCliPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCliPath)
  ) {
    throw new Error("the Vitest package manifest declares an executable outside its package");
  }
  return cliPath;
}

/** Launches Vitest without a command shell so Git-controlled test paths remain argv data. */
export async function runVitestDirect(
  args,
  {
    cwd,
    env,
    run = runGateChild,
    resolvePackage = require.resolve,
    readManifest = readFileSync,
  } = {},
) {
  return await run(process.execPath, [resolveVitestCli(resolvePackage, readManifest), ...args], {
    cwd,
    env,
  });
}

/** Invokes each exact suite independently so one collected file cannot mask an unmatched file. */
export async function forEachExactVitestFile(files, runFile) {
  for (const file of files) await runFile(file);
}
