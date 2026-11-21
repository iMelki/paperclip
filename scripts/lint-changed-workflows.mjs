#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./is-main-module.mjs";
import { createEphemeralDir, ephemeralChildEnv } from "./lib/ephemeral-scratch.mjs";

export class WorkflowLintError extends Error {
  constructor(message, { cause, exitCode = 1 } = {}) {
    super(message, { cause });
    this.name = "WorkflowLintError";
    this.exitCode = exitCode;
  }
}

const WORKFLOW_FILE_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const DOCKER_WORKFLOW = ".github/workflows/docker.yml";
const GHCR_IMAGE_STEP = "Set GHCR image name";
const UNFOLDED_REPOSITORY_IMAGE = "ghcr.io/${{ github.repository }}";
export const IMAGE_ASSIGNMENT = 'echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"';
const ALLOWED_SHELL_OPTIONS = "set -euo pipefail";
export const DOCKER_IMAGE_PROOF_TIMEOUT_MS = 10_000;
const MIXED_CASE_REPOSITORY = "iMelki/PaperClip";
const EXPECTED_IMAGE = "ghcr.io/imelki/paperclip";

export function parseWorkflowLintCli(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--file") {
      throw new WorkflowLintError(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new WorkflowLintError("--file requires a value");
    }
    files.push(value);
    index += 1;
  }
  if (files.length === 0) {
    throw new WorkflowLintError("at least one --file is required");
  }
  return files;
}

export function normalizeWorkflowPath(file) {
  if (typeof file !== "string" || file.includes("\0")) {
    throw new WorkflowLintError("workflow paths must be non-null strings");
  }
  if (file.trim() !== file) {
    throw new WorkflowLintError(`workflow path contains surrounding whitespace: ${file}`);
  }
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "" ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..") ||
    !WORKFLOW_FILE_PATTERN.test(normalized)
  ) {
    throw new WorkflowLintError(`workflow path escapes the workflows directory: ${file}`);
  }
  return normalized;
}

export function resolveExistingWorkflowFiles(repoRoot, files) {
  const existing = [];
  for (const file of files) {
    const normalized = normalizeWorkflowPath(file);
    const absolute = path.resolve(repoRoot, ...normalized.split("/"));
    const relative = path.relative(path.resolve(repoRoot), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WorkflowLintError(`workflow path escapes the repository: ${file}`);
    }
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new WorkflowLintError(`workflow path is not a regular file: ${normalized}`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      if (error instanceof WorkflowLintError) throw error;
      throw new WorkflowLintError(`workflow path could not be read: ${normalized}`, { cause: error });
    }
    existing.push(normalized);
  }
  return [...new Set(existing)].sort();
}

function readRunScalar(lines, runIndex) {
  const declaration = lines[runIndex].match(/^(\s*)run:\s*(.*?)\s*$/);
  if (!declaration) return null;
  const indent = declaration[1].length;
  const value = declaration[2];
  // YAML folds > blocks into spaces; treating their source lines as separate
  // shell commands would prove a different script than the workflow executes.
  if (/^>[+-]?$/.test(value)) {
    throw new WorkflowLintError("folded run scalars are not supported for the IMAGE assignment proof; use |");
  }
  if (!/^[|][+-]?$/.test(value)) return value;
  const commandLines = [];
  const bodyIndent = indent + 2;
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && !new RegExp(`^ {${bodyIndent}}`).test(line) && !/^\s*$/.test(line)) {
      break;
    }
    if (line.trim() === "") continue;
    const content = line.slice(bodyIndent);
    if (content.trim() !== "" && !content.trimStart().startsWith("#")) {
      commandLines.push(content);
    }
  }
  return commandLines.join("\n");
}

export function extractNamedRunScripts(workflow, stepName, requiredStepIndent = null) {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = lines[index].match(/^(\s+)-\s+name:\s+(.+?)\s*$/);
    if (!nameMatch || nameMatch[2] !== stepName) continue;
    const stepIndent = nameMatch[1].length;
    if (requiredStepIndent !== null && stepIndent !== requiredStepIndent) continue;
    let runIndex = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const indent = (line.match(/^ */) ?? [""])[0].length;
      if (indent <= stepIndent) break;
      if (/^\s+run:\s*/.test(line) && (requiredStepIndent === null || indent === stepIndent + 2)) {
        runIndex = cursor;
        break;
      }
    }
    if (runIndex < 0) {
      throw new WorkflowLintError(`workflow step "${stepName}" is missing a run script`);
    }
    const script = readRunScalar(lines, runIndex);
    if (!script) {
      throw new WorkflowLintError(`workflow step "${stepName}" has an unreadable run script`);
    }
    scripts.push(script);
  }
  return scripts;
}

function exactAllowedImageAssignment(script, index) {
  const lines = script.split("\n").filter((line) => line.trim() !== "");
  const imageLines = [];
  const unexpected = [];
  for (const line of lines) {
    if (line === IMAGE_ASSIGNMENT) {
      imageLines.push(line);
    } else if (line === ALLOWED_SHELL_OPTIONS) {
      continue;
    } else {
      unexpected.push(line);
    }
  }
  if (imageLines.length === 0) {
    throw new WorkflowLintError(
      `${GHCR_IMAGE_STEP} #${index + 1} must assign IMAGE with \${GITHUB_REPOSITORY,,}`,
    );
  }
  if (unexpected.length > 0 || imageLines.length !== 1) {
    throw new WorkflowLintError(
      `${GHCR_IMAGE_STEP} #${index + 1} contains commands beyond the allowed IMAGE assignment`,
    );
  }
  return imageLines[0];
}

// This proof accepts block-style jobs and steps. Unsupported flow, alias,
// tag or multiline-quoted structure fails closed; actionlint remains separate.
function workflowStructure(workflow) {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  let scalarIndent = null;
  const structural = lines.map((line) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return "";
    const indent = (line.match(/^ */) ?? [""])[0].length;
    if (scalarIndent !== null) {
      if (indent > scalarIndent) return "";
      scalarIndent = null;
    }
    if (/^\s*\t/.test(line) || /^\s*["']/.test(line)) {
      throw new WorkflowLintError("docker.yml has unsupported YAML structure for both publish jobs");
    }
    const mapping = line.match(/^\s*(?:-\s+)?[A-Za-z_][A-Za-z0-9_-]*:\s*(.*)$/);
    const list = line.match(/^\s*-\s+(.*)$/);
    const value = mapping?.[1] ?? list?.[1] ?? "";
    if (/^[\[{&*!]/.test(value)) {
      throw new WorkflowLintError("docker.yml has unsupported flow or alias structure for both publish jobs");
    }
    if (/^["']/.test(value)) {
      const quote = value[0];
      let closed = -1;
      for (let cursor = 1; cursor < value.length; cursor += 1) {
        if (quote === '"' && value[cursor] === "\\") { cursor += 1; continue; }
        if (value[cursor] !== quote) continue;
        if (quote === "'" && value[cursor + 1] === "'") { cursor += 1; continue; }
        closed = cursor;
        break;
      }
      if (closed < 0 || !/^\s*(?:#.*)?$/.test(value.slice(closed + 1))) {
        throw new WorkflowLintError("docker.yml has unsupported quoted structure for both publish jobs");
      }
    }
    if (/^[|>]/.test(value)) {
      if (!/^[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(value)) {
        throw new WorkflowLintError("docker.yml has unsupported scalar structure for both publish jobs");
      }
      scalarIndent = indent;
    }
    return line;
  });
  return { lines, structural };
}

function extractPublishJobSteps(workflow, jobName) {
  const { lines, structural } = workflowStructure(workflow);
  const jobsHeaders = structural.flatMap((line, index) =>
    /^jobs:\s*(?:#.*)?$/.test(line) ? [index] : []);
  if (jobsHeaders.length !== 1) {
    throw new WorkflowLintError("docker.yml must have one jobs block for both publish jobs");
  }
  const jobs = [];
  let jobsEnd = lines.length;
  for (let index = jobsHeaders[0] + 1; index < lines.length; index += 1) {
    const line = structural[index];
    if (!line) continue;
    if (/^\S/.test(line)) { jobsEnd = index; break; }
    const match = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (match) jobs.push({ name: match[1], index });
  }
  const matches = jobs.filter((job) => job.name === jobName);
  if (matches.length !== 1) {
    throw new WorkflowLintError(
      "docker.yml must define both publish jobs exactly once; " + jobName + " found " + matches.length,
    );
  }
  const start = matches[0].index;
  const end = jobs.find((job) => job.index > start)?.index ?? jobsEnd;
  const steps = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^ {4}steps:\s*(?:#.*)?$/.test(structural[index])) steps.push(index);
  }
  if (steps.length !== 1) {
    throw new WorkflowLintError(
      "docker.yml must define block-style steps in both publish jobs; " + jobName,
    );
  }
  let stepsEnd = end;
  for (let index = steps[0] + 1; index < end; index += 1) {
    if (structural[index] && (structural[index].match(/^ */) ?? [""])[0].length <= 4) {
      stepsEnd = index;
      break;
    }
  }
  return lines.slice(steps[0], stepsEnd).join("\n");
}

export function proveDockerImageLowercase(workflow, {
  spawn = spawnSync,
  repository = MIXED_CASE_REPOSITORY,
  expectedImage = EXPECTED_IMAGE,
  timeoutMs = DOCKER_IMAGE_PROOF_TIMEOUT_MS,
} = {}) {
  if (workflow.includes(UNFOLDED_REPOSITORY_IMAGE)) {
    throw new WorkflowLintError(
      "docker.yml must not use ghcr.io/${{ github.repository }}; GHCR paths must be lowercase",
    );
  }
  const scripts = ["build-and-push", "build-and-push-cloud"].map((jobName) => {
    const scripts = extractNamedRunScripts(extractPublishJobSteps(workflow, jobName), GHCR_IMAGE_STEP, 6);
    if (scripts.length !== 1) {
      throw new WorkflowLintError(
        `docker.yml must define ${GHCR_IMAGE_STEP} exactly once in both publish jobs; ${jobName} found ${scripts.length}`,
      );
    }
    return scripts[0];
  });
  for (const [index, script] of scripts.entries()) {
    // Fail closed on anything beyond the allowed lines, then run only the
    // exact IMAGE assignment — never the rest of the extracted run block.
    const imageLine = exactAllowedImageAssignment(script, index);
    const workDir = createEphemeralDir({ owner: "paperclip", purpose: "workflowimage" });
    const envFile = path.join(workDir, "github.env");
    try {
      writeFileSync(envFile, "");
      const result = spawn("bash", ["-c", imageLine], {
        cwd: workDir,
        env: {
          PATH: process.env.PATH,
          ...ephemeralChildEnv(workDir),
          GITHUB_REPOSITORY: repository,
          GITHUB_ENV: envFile,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      if (result.error) {
        const timedOut =
          result.error.code === "ETIMEDOUT" ||
          result.error.errno === "ETIMEDOUT" ||
          /timed out/i.test(result.error.message ?? "");
        throw new WorkflowLintError(
          timedOut
            ? `${GHCR_IMAGE_STEP} #${index + 1} timed out after ${timeoutMs}ms and was killed`
            : `${GHCR_IMAGE_STEP} #${index + 1} could not start bash: ${result.error.message}`,
          { cause: result.error },
        );
      }
      if (result.status !== 0) {
        if (result.status == null && result.signal) {
          throw new WorkflowLintError(
            `${GHCR_IMAGE_STEP} #${index + 1} timed out after ${timeoutMs}ms and was killed`,
          );
        }
        const stderr = (result.stderr ?? "").trim();
        throw new WorkflowLintError(
          `${GHCR_IMAGE_STEP} #${index + 1} exited ${result.status ?? "unknown"}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      const written = readFileSync(envFile, "utf8");
      const match = written.match(/^IMAGE=(.*)$/m);
      if (!match || match[1] !== expectedImage) {
        throw new WorkflowLintError(
          `${GHCR_IMAGE_STEP} #${index + 1} wrote ${match ? match[1] : "<empty>"}; expected ${expectedImage}`,
        );
      }
    } finally {
      // Retain this invocation’s bounded scratch evidence; no permanent deletion.
    }
  }
}

// Local binary only. This module must not download actionlint or publish anything.
export function resolveActionlintCommand(env = process.env) {
  const configured = typeof env.PAPERCLIP_ACTIONLINT_BIN === "string"
    ? env.PAPERCLIP_ACTIONLINT_BIN.trim()
    : "";
  if (configured) return { command: configured, skipWhenMissing: false };
  return { command: "actionlint", skipWhenMissing: false };
}

export function runActionlint(files, {
  repoRoot,
  spawn = spawnSync,
  command,
  skipWhenMissing,
  log = () => {},
} = {}) {
  const resolved = resolveActionlintCommand();
  const binary = command ?? resolved.command;
  const maySkip = skipWhenMissing ?? (command === undefined && resolved.skipWhenMissing);
  const result = spawn(binary, ["-oneline", "-no-color", ...files], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    if (result.error.code === "ENOENT" && maySkip) {
      log(
        "SKIP: actionlint is not on PATH and PAPERCLIP_ACTIONLINT_BIN is unset. This step does not download actionlint. The docker.yml IMAGE lowercase proof still runs locally.",
      );
      return { skipped: true };
    }
    const detail = result.error.code === "ENOENT"
      ? `actionlint was not found at ${binary}. This step does not download actionlint.`
      : `actionlint could not start: ${result.error.message}`;
    throw new WorkflowLintError(detail, { cause: result.error, exitCode: 2 });
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new WorkflowLintError(
      `actionlint failed with exit ${result.status ?? "unknown"}${output ? `:\n${output}` : ""}`,
    );
  }
  return { skipped: false };
}

export function lintChangedWorkflows(
  files,
  {
    repoRoot = process.cwd(),
    spawn = spawnSync,
    readWorkflow = (absolute) => readFileSync(absolute, "utf8"),
    actionlintCommand,
    skipMissingActionlint,
    log = console.log,
  } = {},
) {
  const resolved = resolveActionlintCommand();
  const command = actionlintCommand ?? resolved.command;
  const skipWhenMissing = skipMissingActionlint ?? (
    actionlintCommand === undefined ? resolved.skipWhenMissing : false
  );
  const existing = resolveExistingWorkflowFiles(repoRoot, files);
  if (existing.length === 0) {
    log("No existing workflow files to lint (all listed paths were deletions).");
    return 0;
  }
  const actionlint = runActionlint(existing, {
    repoRoot,
    spawn,
    command,
    skipWhenMissing,
    log,
  });
  if (!actionlint.skipped) {
    log(`actionlint passed for ${existing.length} workflow file(s).`);
  }
  if (existing.includes(DOCKER_WORKFLOW)) {
    const absolute = path.resolve(repoRoot, ...DOCKER_WORKFLOW.split("/"));
    proveDockerImageLowercase(readWorkflow(absolute), { spawn });
    log("docker.yml GHCR image name is lowercase under a mixed-case GITHUB_REPOSITORY.");
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    const files = parseWorkflowLintCli(process.argv.slice(2));
    process.exit(lintChangedWorkflows(files, { repoRoot: process.cwd() }));
  } catch (error) {
    const message = error instanceof WorkflowLintError ? error.message : error.message;
    process.stderr.write(`ERROR: Workflow lint failed: ${message}\n`);
    process.exit(error instanceof WorkflowLintError ? error.exitCode : 2);
  }
}
