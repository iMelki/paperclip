import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function normalizeComparablePath(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Returns true when an ESM module is the process entry point, including when
 * either path reached the file through a Windows junction or symbolic link.
 */
export function isMainModule(importMetaUrl, argvPath = process.argv[1], realpath = realpathSync) {
  if (!argvPath) return false;
  try {
    const entryPath = realpath(path.resolve(argvPath));
    const modulePath = realpath(fileURLToPath(importMetaUrl));
    return normalizeComparablePath(entryPath) === normalizeComparablePath(modulePath);
  } catch (error) {
    throw new Error(
      `cannot resolve ESM entry point for gate dispatch: ${error?.code ?? error?.message}`,
      { cause: error },
    );
  }
}
