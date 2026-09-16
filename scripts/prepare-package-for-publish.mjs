#!/usr/bin/env node

import { constants, copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, "package.json");
const devPackageJsonPath = join(packageDir, "package.dev.json");
const generatorArgument = process.argv[2];

if (!generatorArgument) {
  throw new Error("Usage: node prepare-package-for-publish.mjs <generator-path>");
}
if (!existsSync(packageJsonPath)) {
  throw new Error(`No package.json found in ${packageDir}`);
}
if (existsSync(devPackageJsonPath)) {
  throw new Error(`Refusing to overwrite existing ${devPackageJsonPath}`);
}

copyFileSync(packageJsonPath, devPackageJsonPath, constants.COPYFILE_EXCL);
try {
  const generatorPath = resolve(packageDir, generatorArgument);
  const result = spawnSync(process.execPath, [generatorPath], {
    cwd: packageDir,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Package generator exited with ${result.status ?? "no status"}`);
} catch (error) {
  try {
    rmSync(packageJsonPath, { force: true });
    renameSync(devPackageJsonPath, packageJsonPath);
  } catch (restoreError) {
    throw new Error(`Package generator failed and restore failed: ${restoreError.message}`, { cause: error });
  }
  throw error;
}
