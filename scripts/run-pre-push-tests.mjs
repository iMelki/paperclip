#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  GIT_CHILD_MAX_BUFFER,
  GIT_CHILD_TIMEOUT_MS,
  assertNormalIndexState,
  parseTrackedManifest,
} from "./git-push-scan-integrity.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { selectPrePushTests } from "./pre-push-test-selection.mjs";

const ZERO_OID_PATTERN = /^0{40}(?:0{24})?$/;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROTECTED_REFS = new Set(["refs/heads/dev", "refs/heads/master"]);

export class PrePushIntegrityError extends Error {
  constructor(message, { cause, exitCode } = {}) {
    super(message, { cause });
    this.name = "PrePushIntegrityError";
    this.exitCode = exitCode;
  }
}

function validateOid(oid, label) {
  if (!OID_PATTERN.test(oid)) {
    throw new PrePushIntegrityError(`${label} is not a full Git object id: ${oid}`);
  }
}

export function parsePushUpdates(input) {
  const updates = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      throw new PrePushIntegrityError(`pre-push update line ${index + 1} must contain four fields`);
    }
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    validateOid(localOid, `line ${index + 1} local oid`);
    validateOid(remoteOid, `line ${index + 1} remote oid`);
    const deletion = ZERO_OID_PATTERN.test(localOid);
    if (!remoteRef.startsWith("refs/")) {
      throw new PrePushIntegrityError(`pre-push update line ${index + 1} contains an invalid remote ref`);
    }
    const validLocalRef = localRef === "HEAD" || localRef.startsWith("refs/");
    if (deletion ? localRef !== "(delete)" : !validLocalRef) {
      throw new PrePushIntegrityError(`pre-push update line ${index + 1} contains an invalid local ref`);
    }
    updates.push({
      localRef,
      localOid,
      remoteRef,
      remoteOid,
      deletion,
      creation: ZERO_OID_PATTERN.test(remoteOid),
    });
  }
  if (updates.length === 0) {
    throw new PrePushIntegrityError("Git supplied no pre-push ref updates");
  }
  return updates;
}

export function runGit(
  repoRoot,
  args,
  {
    encoding = null,
    maxBuffer = GIT_CHILD_MAX_BUFFER,
    timeout = GIT_CHILD_TIMEOUT_MS,
    spawn = spawnSync,
  } = {},
) {
  const result = spawn("git", args, {
    cwd: repoRoot,
    encoding,
    killSignal: "SIGKILL",
    maxBuffer,
    windowsHide: true,
    shell: false,
    timeout,
  });
  if (result.error) {
    throw new PrePushIntegrityError(
      `could not start git ${args[0]}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim();
    throw new PrePushIntegrityError(
      `git ${args[0]} failed with exit ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
      { exitCode: result.status },
    );
  }
  return result.stdout;
}

function readGitText(output) {
  return `${Buffer.isBuffer(output) ? output.toString("utf8") : output ?? ""}`.trim();
}

function normalizeNativePath(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function validateRemoteInputs(remoteName, remoteLocation) {
  if (typeof remoteName !== "string" || !SAFE_REMOTE_PATTERN.test(remoteName)) {
    const renderedName = typeof remoteName === "string" && remoteName !== "" ? remoteName : "(empty or non-string)";
    throw new PrePushIntegrityError(`unsafe or missing remote name: ${renderedName}`);
  }
  if (typeof remoteLocation !== "string" || remoteLocation.trim() === "" || remoteLocation.includes("\0")) {
    throw new PrePushIntegrityError("Git supplied an unsafe or missing remote location");
  }
}

export function resolveAuthoritativeRemoteDevOid({
  repoRoot,
  remoteName,
  remoteLocation,
  git = runGit,
}) {
  assertRemoteLocationMatchesConfig({ repoRoot, remoteName, remoteLocation, git });
  const advertisement = readGitText(
    git(
      repoRoot,
      ["ls-remote", "--refs", "--heads", "--exit-code", "--", remoteLocation, "refs/heads/dev"],
      { encoding: "utf8" },
    ),
  );
  const lines = advertisement.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new PrePushIntegrityError(
      `push destination must advertise exactly one refs/heads/dev object; received ${lines.length}`,
    );
  }
  const fields = lines[0].split(/\s+/);
  if (fields.length !== 2 || fields[1] !== "refs/heads/dev") {
    throw new PrePushIntegrityError("push destination returned a malformed refs/heads/dev advertisement");
  }
  validateOid(fields[0], "advertised refs/heads/dev oid");
  return fields[0].toLowerCase();
}

export function assertRemoteLocationMatchesConfig({
  repoRoot,
  remoteName,
  remoteLocation,
  git = runGit,
}) {
  validateRemoteInputs(remoteName, remoteLocation);
  const configuredUrls = readGitText(
    git(repoRoot, ["remote", "get-url", "--push", "--all", remoteName], { encoding: "utf8" }),
  ).split(/\r?\n/).filter(Boolean);
  if (!configuredUrls.includes(remoteLocation)) {
    throw new PrePushIntegrityError(
      `Git remote location does not match a configured push URL for ${remoteName}`,
    );
  }
}

export function assertAdvertisedDevAncestor({
  repoRoot,
  remoteDevOid,
  localOid,
  remoteRef,
  git = runGit,
}) {
  try {
    git(repoRoot, ["merge-base", "--is-ancestor", remoteDevOid, localOid]);
  } catch (error) {
    if (error instanceof PrePushIntegrityError && error.exitCode === 1) {
      throw new PrePushIntegrityError(
        `pushed ref ${remoteRef} must contain advertised refs/heads/dev object ${remoteDevOid}`,
        { cause: error, exitCode: 1 },
      );
    }
    throw error;
  }
}

export function assertPushMatchesWorkingTree({ repoRoot, updates, git = runGit }) {
  const contentUpdates = updates.filter((update) => !update.deletion);
  if (contentUpdates.length === 0) return { headOid: null, trackedFiles: new Set() };
  if (contentUpdates.length !== 1) {
    throw new PrePushIntegrityError(
      "the deterministic local gate accepts exactly one non-deletion ref update per push",
    );
  }

  const headOid = readGitText(git(repoRoot, ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }));
  validateOid(headOid, "current HEAD oid");
  if (contentUpdates[0].localOid.toLowerCase() !== headOid.toLowerCase()) {
    throw new PrePushIntegrityError("the pushed object must be the current checked-out HEAD");
  }

  const topLevel = readGitText(
    git(repoRoot, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }),
  );
  if (normalizeNativePath(topLevel) !== normalizeNativePath(repoRoot)) {
    throw new PrePushIntegrityError("--repo-root does not match Git's checked-out worktree root");
  }

  const manifest = parseTrackedManifest(
    git(repoRoot, ["ls-files", "-v", "-z"]),
    repoRoot,
  );
  assertNormalIndexState(manifest.nonStandardIndexPaths);

  const status = git(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  if (Buffer.from(status ?? "").length > 0) {
    throw new PrePushIntegrityError(
      "the worktree and index must be pristine so tests match the pushed HEAD",
    );
  }

  const tree = git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", headOid]);
  return { headOid, trackedFiles: new Set(parseNullDelimited(tree)) };
}

function parseNullDelimited(output) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output ?? "");
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function readHeadTrackedFiles({ repoRoot, git = runGit }) {
  const headOid = readGitText(git(repoRoot, ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }));
  validateOid(headOid, "current HEAD oid");
  return new Set(parseNullDelimited(
    git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", headOid]),
  ));
}

export function resolveOutgoingChangedFiles({
  repoRoot,
  remoteName,
  remoteLocation,
  updates,
  git = runGit,
}) {
  const contentUpdates = updates.filter((update) => !update.deletion);
  const remoteDevOid = contentUpdates.length > 0
    ? resolveAuthoritativeRemoteDevOid({ repoRoot, remoteName, remoteLocation, git })
    : null;
  const changedFiles = new Set();
  for (const update of contentUpdates) {
    assertAdvertisedDevAncestor({
      repoRoot,
      remoteDevOid,
      localOid: update.localOid,
      remoteRef: update.remoteRef,
      git,
    });
    const output = git(
      repoRoot,
      [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=ACDMRTUXB",
        remoteDevOid,
        update.localOid,
        "--",
      ],
    );
    parseNullDelimited(output).forEach((file) => changedFiles.add(file));
  }
  return [...changedFiles].sort();
}

function runChild(
  label,
  args,
  { spawn = spawnSync, log = console.log, error = console.error, cwd = process.cwd() } = {},
) {
  log(`Running ${label}...`);
  const result = spawn(process.execPath, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    error(`ERROR: ${label} could not start: ${result.error.message}`);
    return 2;
  }
  if (result.status !== 0) {
    error(`ERROR: ${label} failed with exit ${result.status ?? "unknown"}.`);
    return result.status ?? 2;
  }
  return 0;
}

export function executeTestPlan(
  { selection, targetRefs },
  { spawn = spawnSync, log = console.log, error = console.error, repoRoot = process.cwd() } = {},
) {
  if (selection.selectionErrors.length > 0) {
    error("ERROR: deterministic pre-push test selection failed closed:");
    selection.selectionErrors.forEach((item) => error(`  ${item}`));
    return 2;
  }

  const protectedTargets = targetRefs.filter((ref) => PROTECTED_REFS.has(ref));
  if (selection.hostedCiFiles.length > 0 && protectedTargets.length > 0) {
    error(
      `ERROR: changes requiring hosted CI cannot be pushed directly to ${protectedTargets.join(", ")}.`,
    );
    selection.hostedCiFiles.forEach((file) => error(`  ${file}`));
    error("Push a topic branch and open a pull request into dev so the Linux/clean-install lanes run.");
    return 2;
  }

  if (selection.hostedCiFiles.length > 0) {
    log(`Hosted PR CI required for ${selection.hostedCiFiles.length} changed path(s).`);
    selection.hostedCiFiles.forEach((file) => log(`  CI: ${file}`));
  }

  if (selection.nodeTestFiles.length > 0) {
    const status = runChild(
      `exact Node test suites (${selection.nodeTestFiles.length})`,
      ["--test", ...selection.nodeTestFiles],
      { spawn, log, error, cwd: repoRoot },
    );
    if (status !== 0) return status;
  }

  if (selection.vitestFiles.length > 0) {
    const status = runChild(
      `exact Vitest suites (${selection.vitestFiles.length})`,
      [path.join(repoRoot, "scripts/run-vitest-stable.mjs"), "--files", ...selection.vitestFiles],
      { spawn, log, error, cwd: repoRoot },
    );
    if (status !== 0) return status;
  }

  if (selection.nodeTestFiles.length === 0 && selection.vitestFiles.length === 0) {
    log("No local unit suite was selected; any declared hosted-only coverage remains visible above.");
  }
  return 0;
}

function parseCli(argv) {
  const options = {
    repoRoot: process.cwd(),
    remoteName: "",
    remoteLocation: "",
    updatesFile: "",
    changedFiles: [],
    targetRefs: [],
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const valueOptions = new Map([
      ["--repo-root", "repoRoot"],
      ["--remote-name", "remoteName"],
      ["--remote-location", "remoteLocation"],
      ["--updates-file", "updatesFile"],
      ["--changed-file", "changedFiles"],
      ["--target-ref", "targetRefs"],
    ]);
    const key = valueOptions.get(arg);
    if (!key) throw new PrePushIntegrityError(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new PrePushIntegrityError(`${arg} requires a value`);
    }
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = value;
    index += 1;
  }
  options.repoRoot = path.resolve(options.repoRoot);
  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.changedFiles.length > 0 && !options.dryRun) {
      throw new PrePushIntegrityError("--changed-file is available only with --dry-run");
    }
    let updates = [];
    let changedFiles = options.changedFiles;
    let targetRefs = options.targetRefs;
    let trackedFiles;
    if (changedFiles.length === 0) {
      if (!options.updatesFile) throw new PrePushIntegrityError("--updates-file is required");
      updates = parsePushUpdates(readFileSync(options.updatesFile, "utf8"));
      ({ trackedFiles } = assertPushMatchesWorkingTree({
        repoRoot: options.repoRoot,
        updates,
      }));
      changedFiles = resolveOutgoingChangedFiles({
        repoRoot: options.repoRoot,
        remoteName: options.remoteName,
        remoteLocation: options.remoteLocation,
        updates,
      });
      targetRefs = updates.map((update) => update.remoteRef);
    } else {
      trackedFiles = readHeadTrackedFiles({ repoRoot: options.repoRoot });
    }
    if (targetRefs.length === 0) targetRefs = ["refs/heads/topic"];
    if (changedFiles.length === 0) {
      const emptyPlan = { changedFiles, targetRefs, selection: null };
      if (options.dryRun) process.stdout.write(`${JSON.stringify(emptyPlan, null, 2)}\n`);
      else process.stdout.write("No changed paths require a local test plan.\n");
      process.exit(0);
    }
    const selection = selectPrePushTests({
      repoRoot: options.repoRoot,
      changedFiles,
      trackedFiles,
    });
    const plan = { changedFiles, targetRefs, selection };
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      process.exit(selection.selectionErrors.length > 0 ? 2 : 0);
    }
    process.exit(executeTestPlan(plan, { repoRoot: options.repoRoot }));
  } catch (error) {
    process.stderr.write(`ERROR: Pre-push plan integrity failure: ${error.message}\n`);
    process.exit(2);
  }
}
