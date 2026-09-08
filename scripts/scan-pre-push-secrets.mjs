#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./is-main-module.mjs";
import {
  assertAdvertisedDevAncestor,
  assertRemoteLocationMatchesConfig,
  parsePushUpdates,
  resolveAuthoritativeRemoteDevOid,
  runGit,
  validateRemoteInputs,
} from "./run-pre-push-tests.mjs";

export class PrePushSecretScanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrePushSecretScanError";
  }
}

export function buildPrePushSecretScans({
  repoRoot,
  remoteName,
  remoteLocation,
  updates,
  git = runGit,
}) {
  try {
    validateRemoteInputs(remoteName, remoteLocation);
  } catch (cause) {
    throw new PrePushSecretScanError(cause.message);
  }
  if (
    updates.some((update) => !update.deletion) &&
    !updates.some((update) => update.creation && !update.deletion)
  ) {
    assertRemoteLocationMatchesConfig({ repoRoot, remoteName, remoteLocation, git });
  }
  let remoteDevOid = null;
  return updates.filter((update) => !update.deletion).map((update) => {
    if (update.creation) {
      remoteDevOid ??= resolveAuthoritativeRemoteDevOid({
        repoRoot,
        remoteName,
        remoteLocation,
        git,
      });
      assertAdvertisedDevAncestor({
        repoRoot,
        remoteDevOid,
        localOid: update.localOid,
        remoteRef: update.remoteRef,
        git,
      });
    }
    return {
      localRef: update.localRef,
      remoteRef: update.remoteRef,
      args: ["--range", `${update.creation ? remoteDevOid : update.remoteOid}..${update.localOid}`],
    };
  });
}

export function executePrePushSecretScans(
  scans,
  {
    repoRoot = process.cwd(),
    spawn = spawnSync,
    log = console.log,
    error = console.error,
  } = {},
) {
  const verifier = path.join(repoRoot, "scripts", "verify-gitleaks.mjs");
  for (const scan of scans) {
    log(`Scanning outgoing secrets for ${scan.localRef} -> ${scan.remoteRef}...`);
    const result = spawn(process.execPath, [verifier, ...scan.args], {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      error(`ERROR: outgoing secret scan could not start: ${result.error.message}`);
      return 2;
    }
    if (result.status !== 0) {
      const outcome = result.signal
        ? `terminated by signal ${result.signal}`
        : `failed with exit ${result.status ?? "unknown"}`;
      error(`ERROR: outgoing secret scan ${outcome}.`);
      return result.status ?? 2;
    }
  }
  if (scans.length === 0) log("No non-deletion ref update requires an outgoing secret scan.");
  return 0;
}

function parseCli(argv) {
  const options = {
    repoRoot: process.cwd(),
    remoteName: "",
    remoteLocation: "",
    updatesFile: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = new Map([
      ["--repo-root", "repoRoot"],
      ["--remote-name", "remoteName"],
      ["--remote-location", "remoteLocation"],
      ["--updates-file", "updatesFile"],
    ]).get(arg);
    if (!key) throw new PrePushSecretScanError(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new PrePushSecretScanError(`${arg} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.updatesFile) throw new PrePushSecretScanError("--updates-file is required");
  options.repoRoot = path.resolve(options.repoRoot);
  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const updates = parsePushUpdates(readFileSync(options.updatesFile, "utf8"));
    const scans = buildPrePushSecretScans({
      repoRoot: options.repoRoot,
      remoteName: options.remoteName,
      remoteLocation: options.remoteLocation,
      updates,
    });
    process.exit(executePrePushSecretScans(scans, { repoRoot: options.repoRoot }));
  } catch (error) {
    process.stderr.write(`ERROR: Pre-push secret scan integrity failure: ${error.message}\n`);
    process.exit(2);
  }
}
