#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./is-main-module.mjs";

const REQUIRED_POLICY_VALIDATION_COMMANDS = [
  "node ./scripts/check-no-git-push.mjs",
  "node ./scripts/check-pr-workflow-trigger.mjs",
];

const REQUIRED_JOB_KEYS = {
  "secret-scan": new Set(["name", "runs-on", "timeout-minutes", "permissions", "steps"]),
  policy: new Set(["name", "needs", "runs-on", "timeout-minutes", "outputs", "permissions", "steps"]),
};

const REQUIRED_POLICY_TEST_PATHS = [
  "./scripts/check-no-git-push-source.test.mjs",
  "./scripts/git-push-scan-integrity.test.mjs",
  "./scripts/check-no-git-push.test.mjs",
  "./scripts/check-pr-workflow-trigger.test.mjs",
  "./scripts/is-main-module.test.mjs",
  "./scripts/pre-push-callers.test.mjs",
  "./scripts/pre-push-test-selection.test.mjs",
  "./scripts/run-vitest-direct.test.mjs",
  "./scripts/__tests__/run-vitest-stable-shard.test.mjs",
  "./scripts/scan-pre-push-secrets.test.mjs",
  "./scripts/run-pre-push-tests.test.mjs",
  "./scripts/verify-gitleaks.test.mjs",
];

function extractTopLevelBlock(workflow, key) {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  const keyPattern = new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:\\s*$`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start < 0) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // YAML comments do not close a mapping, even at column zero. Keep them in
    // the block so later indented entries are still validated; readers skip comments.
    if (line !== "" && !/^\s/.test(line) && !/^\s*#/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function extractEventBlock(onBlock, eventName) {
  const lines = onBlock.split("\n");
  const eventPattern = new RegExp(
    `^  (?:${eventName}|"${eventName}"|'${eventName}')\\s*:\\s*$`,
  );
  const start = lines.findIndex((line) => eventPattern.test(line));
  if (start < 0) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  (?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*:\s*/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function extractEventList(eventBlock, key) {
  const lines = eventBlock.split("\n");
  const keyPattern = new RegExp(`^    (?:${key}|"${key}"|'${key}')\\s*:\\s*$`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start < 0) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^    (?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*:\s*/.test(line)) break;
    const match = line.match(/^\s{6}-\s+([^#\s]+)\s*$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function validatePlainMappingKeys(
  block,
  indent,
  allowedKeys,
  label,
  { allowInlineValues = false } = {},
) {
  const prefix = " ".repeat(indent);
  const childPrefix = `${prefix} `;
  const keys = [];
  const failures = [];
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(prefix) || line.startsWith(childPrefix)) continue;
    const suffix = allowInlineValues ? ".*$" : "(?:#.*)?$";
    const match = line.match(new RegExp(`^${prefix}([A-Za-z0-9_-]+)\\s*:\\s*${suffix}`));
    if (!match) {
      failures.push(`${label} contains an unsupported, encoded, or inline mapping key: ${line.trim()}`);
      continue;
    }
    keys.push(match[1]);
    if (allowedKeys && !allowedKeys.has(match[1])) {
      failures.push(`${label} contains unsupported key ${match[1]}`);
    }
  }
  return { keys, failures };
}

function readRunScalar(stepLines, runIndex) {
  const declaration = stepLines[runIndex].match(/^        run:\s*(.*?)\s*$/);
  if (!declaration) return null;
  const value = declaration[1];
  if (!/^[>|][+-]?$/.test(value)) return value;
  const commandLines = [];
  for (let index = runIndex + 1; index < stepLines.length; index += 1) {
    const line = stepLines[index];
    if (line.trim() !== "" && !/^\s{10}/.test(line)) break;
    const content = line.replace(/^\s{10}/, "").trim();
    if (content !== "" && !content.startsWith("#")) commandLines.push(content);
  }
  return commandLines.join(" ");
}

function extractStepRuns(jobBlock) {
  const lines = jobBlock.split("\n");
  const starts = lines
    .map((line, index) => (/^      -\s+/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const steps = [];
  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position];
    let end = starts[position + 1] ?? lines.length;
    for (let index = start + 1; index < end; index += 1) {
      if (lines[index].trim() !== "" && /^ {0,4}\S/.test(lines[index])) {
        end = index;
        break;
      }
    }
    const stepLines = lines.slice(start, end);
    const stepKeys = [];
    let ambiguousMapping = false;
    const openerKey = stepLines[0].match(/^      -\s+([A-Za-z0-9_-]+)\s*:/)?.[1];
    if (!openerKey) ambiguousMapping = true;
    else stepKeys.push(openerKey);
    for (const line of stepLines.slice(1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#") || !/^ {8}\S/.test(line)) continue;
      const key = line.match(/^        ([A-Za-z0-9_-]+)\s*:/)?.[1];
      if (!key) ambiguousMapping = true;
      else stepKeys.push(key);
    }
    if (new Set(stepKeys).size !== stepKeys.length) ambiguousMapping = true;
    const runIndexes = stepLines
      .map((line, index) => (/^        run\s*:/.test(line) ? index : -1))
      .filter((index) => index >= 0);
    if (runIndexes.length !== 1) continue;
    steps.push({
      command: readRunScalar(stepLines, runIndexes[0]),
      masksFailure:
        ambiguousMapping ||
        stepKeys.some((key) => !["name", "run"].includes(key)),
    });
  }
  return steps;
}

function containsShellControl(command) {
  return /&&|\|\||[;&|]/.test(command ?? "");
}

function hasExactUnmaskedStep(steps, command) {
  return steps.some(
    (step) => step.command === command && !step.masksFailure && !containsShellControl(step.command),
  );
}

function collectActiveNodeTestPaths(steps) {
  const testPaths = new Set();
  for (const step of steps) {
    if (step.masksFailure || containsShellControl(step.command)) continue;
    const tokens = step.command?.trim().split(/\s+/) ?? [];
    const paths = tokens.slice(2);
    if (
      tokens[0] !== "node" ||
      tokens[1] !== "--test" ||
      paths.length === 0 ||
      paths.some((testPath) => !/^\.\/scripts\/\S+\.test\.mjs$/.test(testPath))
    ) {
      continue;
    }
    paths.forEach((testPath) => testPaths.add(testPath));
  }
  return testPaths;
}

function validateTopLevelMapping(workflow) {
  const keys = [];
  const failures = [];
  for (const line of workflow.replaceAll("\r\n", "\n").split("\n")) {
    if (line.trim() === "" || line.startsWith("#") || /^---\s*$/.test(line)) continue;
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match) {
      if (line.includes(":")) {
        failures.push(`workflow contains an unsupported or encoded top-level mapping key: ${line.trim()}`);
      }
      continue;
    }
    keys.push(match[1]);
  }
  for (const key of new Set(keys)) {
    if (keys.filter((candidate) => candidate === key).length > 1) {
      failures.push(`workflow must not define duplicate top-level ${key} keys`);
    }
  }
  if (keys.filter((key) => key === "on").length !== 1) {
    failures.push("workflow must define exactly one plain top-level on block");
  }
  for (const forbidden of ["env", "defaults"]) {
    if (keys.includes(forbidden)) {
      failures.push(`workflow must not define top-level ${forbidden} execution context`);
    }
  }
  return failures;
}

export function validatePrWorkflowTrigger(workflow) {
  const failures = validateTopLevelMapping(workflow);
  validateTrigger(workflow, failures);
  validateJobs(workflow, failures);
  return failures;
}

function validateTrigger(workflow, failures) {
  const onBlock = extractTopLevelBlock(workflow, "on");
  if (onBlock === null) {
    failures.push("workflow is missing a top-level on block");
    return;
  }
  if (/^  (?:push|"push"|'push')\s*:/m.test(onBlock)) {
    failures.push("workflow must not define a push event; dev validation is pull-request-only");
  }
  const eventKeys = validatePlainMappingKeys(
    onBlock,
    2,
    new Set(["pull_request"]),
    "workflow on block",
  );
  failures.push(...eventKeys.failures);
  if (eventKeys.keys.filter((key) => key === "pull_request").length !== 1) {
    failures.push("workflow must define exactly one plain pull_request event");
  }
  const pullRequestBlock = extractEventBlock(onBlock, "pull_request");
  if (pullRequestBlock === null) {
    failures.push("workflow must define the pull_request event");
    return;
  }
  const pullRequestKeys = validatePlainMappingKeys(
    pullRequestBlock,
    4,
    new Set(["branches"]),
    "pull_request block",
  );
  failures.push(...pullRequestKeys.failures);
  if (pullRequestKeys.keys.filter((key) => key === "branches").length !== 1) {
    failures.push("pull_request must define exactly one plain branches list");
  }
  const branches = new Set(extractEventList(pullRequestBlock, "branches"));
  for (const required of ["master", "dev"]) {
    if (!branches.has(required)) failures.push(`pull_request.branches is missing ${required}`);
  }
}

function validateJobs(workflow, failures) {
  const jobsBlock = extractTopLevelBlock(workflow, "jobs");
  if (jobsBlock === null) {
    failures.push("workflow is missing a top-level jobs block");
    return;
  }
  const jobKeys = validatePlainMappingKeys(jobsBlock, 2, null, "workflow jobs block");
  failures.push(...jobKeys.failures);
  for (const requiredJob of ["secret-scan", "policy"]) {
    if (jobKeys.keys.filter((key) => key === requiredJob).length !== 1) {
      failures.push(`workflow must define exactly one plain ${requiredJob} job`);
    }
  }
  validateSecretJob(jobsBlock, failures);
  validatePolicyJob(jobsBlock, failures);
}

function readRequiredJob(jobsBlock, jobName, failures) {
  const job = extractEventBlock(jobsBlock, jobName) ?? "";
  const jobKeys = validatePlainMappingKeys(
    job,
    4,
    null,
    `${jobName} job`,
    { allowInlineValues: true },
  );
  failures.push(...jobKeys.failures);
  const duplicateKeys = [...new Set(
    jobKeys.keys.filter((key, index) => jobKeys.keys.indexOf(key) !== index),
  )];
  if (duplicateKeys.length > 0) {
    failures.push(`${jobName} job must not define duplicate keys: ${duplicateKeys.join(", ")}`);
  }
  if (jobKeys.keys.filter((key) => key === "steps").length !== 1) {
    failures.push(`${jobName} job must define exactly one plain steps block`);
  }
  if (jobKeys.keys.some((key) => ["if", "continue-on-error", "defaults"].includes(key))) {
    failures.push(`${jobName} job must run unconditionally without custom defaults`);
  }
  const unsupportedKeys = jobKeys.keys.filter((key) => !REQUIRED_JOB_KEYS[jobName].has(key));
  if (unsupportedKeys.length > 0) {
    failures.push(`${jobName} job contains unsupported execution keys: ${unsupportedKeys.join(", ")}`);
  }
  if ((job.match(/^    runs-on: ubuntu-latest$/gm) ?? []).length !== 1) {
    failures.push(`${jobName} job must run exactly once on ubuntu-latest`);
  }
  return { job, steps: extractStepRuns(job) };
}

function validateSecretJob(jobsBlock, failures) {
  const expectedSecretRange =
    'node scripts/verify-gitleaks.mjs --range "${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}"';
  const { steps } = readRequiredJob(jobsBlock, "secret-scan", failures);
  if (!hasExactUnmaskedStep(steps, expectedSecretRange)) {
    failures.push("workflow must scan the exact pull-request base.sha..head.sha range");
  }
  if (steps.some((step) => {
    const tokens = step.command?.split(/\s+/) ?? [];
    return tokens.includes("scripts/verify-gitleaks.mjs") && tokens.includes("--history");
  })) {
    failures.push("workflow must not use the known-red complete-history secret scan");
  }
}

function validatePolicyJob(jobsBlock, failures) {
  const { job, steps } = readRequiredJob(jobsBlock, "policy", failures);
  if ((job.match(/^    needs: \[secret-scan\]$/gm) ?? []).length !== 1) {
    failures.push("policy job must depend exactly on secret-scan");
  }
  for (const command of REQUIRED_POLICY_VALIDATION_COMMANDS) {
    if (!hasExactUnmaskedStep(steps, command)) {
      failures.push(`workflow policy validation is missing active command: ${command}`);
    }
  }
  const activeTestPaths = collectActiveNodeTestPaths(steps);
  for (const testPath of REQUIRED_POLICY_TEST_PATHS) {
    if (!activeTestPaths.has(testPath)) {
      failures.push(`workflow policy tests are missing ${testPath}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  const workflowPath = path.resolve(process.cwd(), ".github/workflows/pr.yml");
  try {
    const failures = validatePrWorkflowTrigger(readFileSync(workflowPath, "utf8"));
    if (failures.length > 0) {
      process.stderr.write(`ERROR: PR workflow trigger policy failed:\n${failures.map((item) => `  ${item}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("PR workflow trigger policy passed: pull requests into master and dev; no push event.\n");
  } catch (error) {
    process.stderr.write(`ERROR: PR workflow trigger policy could not inspect pr.yml: ${error.message}\n`);
    process.exit(2);
  }
}
