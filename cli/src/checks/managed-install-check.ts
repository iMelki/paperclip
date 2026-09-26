import fs from "node:fs";
import path from "node:path";
import {
  findStrandedPrevLinks,
  MANAGED_SHIM_MARKER,
  manualCurrentRecoveryCommand,
  readInstallManifest,
  resolveInstallStorePaths,
  type InstallStorePaths,
} from "../install-store.js";
import type { CheckResult } from "./index.js";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalized);
}

function hasManagedArtifacts(paths: InstallStorePaths): boolean {
  const persistentArtifacts = [
    paths.manifestPath,
    paths.markerPath,
    paths.currentPath,
    paths.shimPath,
  ].some((entry) => fs.existsSync(entry));
  if (persistentArtifacts) return true;
  try {
    return fs.readdirSync(paths.installsRoot).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

/**
 * On Windows, flipCurrent renames `current` aside before renaming the new link
 * in. A crash in between leaves no `current`, which also breaks the shim, so
 * report that state by name and give the exact recovery.
 */
function strandedCurrentCheck(paths: InstallStorePaths): CheckResult | null {
  const prevLinks = findStrandedPrevLinks(paths);
  if (prevLinks.length === 0) return null;
  let currentPresent = true;
  try {
    fs.lstatSync(paths.currentPath);
  } catch {
    currentPresent = false;
  }
  if (!currentPresent) {
    return {
      name: "Managed install current link",
      status: "fail",
      message: prevLinks.length === 1
        ? `${paths.currentPath} is missing after an interrupted update; the last good link is ${prevLinks[0]}`
        : `${paths.currentPath} is missing and ${prevLinks.length} previous links exist: ${prevLinks.join(", ")}`,
      repairHint: prevLinks.length === 1
        ? `Restore it: ${manualCurrentRecoveryCommand(prevLinks[0]!, paths)}`
        : `Restore the correct one, e.g. ${manualCurrentRecoveryCommand(prevLinks[0]!, paths)}`,
    };
  }
  return {
    name: "Managed install current link",
    status: "warn",
    message: `Leftover previous link(s) from an earlier update: ${prevLinks.join(", ")}`,
    repairHint: "Safe to remove; each is a link, not a payload. Removing it never deletes the payload it points to.",
  };
}

export function nodeRuntimeCheck(): CheckResult {
  return isSupportedNodeVersion(process.versions.node)
    ? { name: "Node.js runtime", status: "pass", message: `Node.js ${process.versions.node}` }
    : {
        name: "Node.js runtime",
        status: "fail",
        message: `Node.js ${process.versions.node} is unsupported`,
        repairHint: `Install Node.js ${MINIMUM_NODE_VERSION} or newer before installing or running Paperclip`,
      };
}

export function managedInstallChecks(
  paths = resolveInstallStorePaths(),
): CheckResult[] {
  if (!hasManagedArtifacts(paths)) {
    return [
      {
        name: "Managed install",
        status: "pass",
        message: "Not present (optional for npx, global npm, and source-checkout usage)",
      },
    ];
  }

  let manifest;
  try {
    manifest = readInstallManifest(paths);
  } catch (error) {
    return [
      {
        name: "Managed install manifest",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
        repairHint: "Re-run `paperclipai install` to rebuild the managed install metadata",
      },
    ];
  }

  if (!manifest) {
    return [
      {
        name: "Managed install manifest",
        status: "fail",
        message: `Managed install artifacts exist but ${paths.manifestPath} is missing`,
        repairHint: "Re-run `paperclipai install`",
      },
    ];
  }

  const results: CheckResult[] = [];
  const stranded = strandedCurrentCheck(paths);
  if (stranded) results.push(stranded);
  const payloadPath = path.resolve(manifest.payloadPath);
  const relativePayload = path.relative(paths.installsRoot, payloadPath);
  const payloadInStore = Boolean(relativePayload) && !relativePayload.startsWith("..") && !path.isAbsolute(relativePayload);
  const payloadExists = payloadInStore && fs.existsSync(payloadPath) && fs.statSync(payloadPath).isDirectory();
  let currentMatches = false;
  try {
    currentMatches = fs.lstatSync(paths.currentPath).isSymbolicLink()
      && fs.realpathSync(paths.currentPath) === fs.realpathSync(payloadPath);
  } catch {
    currentMatches = false;
  }

  results.push(
    payloadExists && currentMatches
      ? {
          name: "Managed install store",
          status: "pass",
          message: `${manifest.source} ${manifest.version} is active`,
        }
      : {
          name: "Managed install store",
          status: "fail",
          message: !payloadExists
            ? `Manifest payload is missing or outside the install store: ${manifest.payloadPath}`
            : `Current link does not point to ${manifest.payloadPath}`,
          repairHint: "Re-run `paperclipai install` or roll back to a retained payload",
        },
  );

  let shimValid = false;
  try {
    shimValid = fs.readFileSync(paths.shimPath, "utf8").includes(MANAGED_SHIM_MARKER);
  } catch {
    shimValid = false;
  }
  results.push(
    shimValid
      ? { name: "Managed install shim", status: "pass", message: paths.shimPath }
      : {
          name: "Managed install shim",
          status: "fail",
          message: `Missing or unrecognized shim at ${paths.shimPath}`,
          repairHint: "Re-run `paperclipai install`",
        },
  );

  const shimDirectory = path.dirname(paths.shimPath);
  results.push(
    pathContains(shimDirectory)
      ? { name: "Managed install PATH", status: "pass", message: `${shimDirectory} is on PATH` }
      : {
          name: "Managed install PATH",
          status: "warn",
          message: `${shimDirectory} is not on PATH`,
          repairHint: 'Run `export PATH="$HOME/.local/bin:$PATH"` and add it to your shell startup file',
        },
  );

  const retained = new Set(
    [manifest, ...manifest.previous].map((record) => path.resolve(record.payloadPath)),
  );
  const orphaned: string[] = [];
  for (const source of ["npm", "git"] as const) {
    const sourceRoot = path.join(paths.installsRoot, source);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of fs.readdirSync(sourceRoot)) {
      const candidate = path.join(sourceRoot, entry);
      if (!entry.startsWith(".") && !retained.has(path.resolve(candidate))) orphaned.push(candidate);
    }
  }
  results.push(
    orphaned.length === 0
      ? { name: "Managed install retention", status: "pass", message: "No orphaned payloads" }
      : {
          name: "Managed install retention",
          status: "warn",
          message: `${orphaned.length} orphaned payload${orphaned.length === 1 ? "" : "s"} found`,
          repairHint: "A successful `paperclipai update` prunes unretained payloads",
        },
  );

  return results;
}
