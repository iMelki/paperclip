#!/usr/bin/env node
/**
 * Fail closed when the privileged pull_request_target checkout contract drifts.
 *
 * This intentionally parses only the workflow's small, indentation-based
 * subset. A workflow shape it cannot recognize is rejected instead of guessed.
 */
import {
  copyFileSync,
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_URL = new URL('../workflows/commitperclip-review.yml', import.meta.url);
const CHECKER_COMMAND = 'node .github/scripts/check-trusted-review-workflow.mjs --record-policy-contract "$RUNNER_TEMP"';
const POLICY_VERIFY_COMMAND = 'node "${{ steps.policy-contract.outputs.contract_dir }}/check-trusted-review-workflow.mjs" --verify-policy-contract "${{ steps.policy-contract.outputs.contract_dir }}/policy-contract.json"';
const TRUSTED_WORKFLOW_REF = '${{ github.workflow_sha }}';
const TRUSTED_BASE_REF = '${{ github.event.pull_request.base.sha }}';
const POLICY_FILES = [
  '.github/scripts/check-fork-dependency-policy.mjs',
  '.github/scripts/fetch-pr-files.mjs',
  '.github/scripts/get-bot-token.mjs',
];
const CONTRACT_VERSION = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readPolicyFiles(root) {
  const rootPath = realpathSync(root);
  const sources = {};
  for (const relativePath of POLICY_FILES) {
    const path = resolve(rootPath, relativePath);
    const rel = relative(rootPath, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Policy contract path escaped the checkout: ${relativePath}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Policy contract input must be a regular file: ${relativePath}`);
    }
    const realPath = realpathSync(path);
    const realRel = relative(rootPath, realPath);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new Error(`Policy contract input resolved outside the checkout: ${relativePath}`);
    }
    sources[relativePath] = readFileSync(realPath);
  }
  return sources;
}

export function createPolicyContract(sources) {
  const files = {};
  for (const relativePath of POLICY_FILES) {
    const source = sources[relativePath];
    if (source === undefined) throw new Error(`Missing policy contract input: ${relativePath}`);
    files[relativePath] = sha256(source);
  }
  return { version: CONTRACT_VERSION, files };
}

export function verifyPolicyContract(contract, sources) {
  if (!contract || contract.version !== CONTRACT_VERSION || !contract.files ||
      Object.keys(contract.files).length !== POLICY_FILES.length ||
      POLICY_FILES.some((path) => !/^[a-f0-9]{64}$/.test(contract.files[path] ?? ''))) {
    return { passed: false, errors: ['trusted policy contract has an unsupported or incomplete shape'] };
  }

  const actual = createPolicyContract(sources);
  const driftedFiles = POLICY_FILES.filter((path) => contract.files[path] !== actual.files[path]);
  if (driftedFiles.length) {
    return {
      passed: false,
      errors: [`base-ref policy files differ from trusted workflow contract: ${driftedFiles.join(', ')}`],
    };
  }
  return { passed: true, errors: [] };
}

function recordPolicyContract(outputDirectory) {
  if (!outputDirectory || !isAbsolute(outputDirectory)) {
    throw new Error('Policy contract output directory must be an absolute path.');
  }
  const outputRoot = realpathSync(outputDirectory);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required to publish the private contract path to the next workflow step.');
  const directory = mkdtempSync(join(outputRoot, 'trusted-review-contract-'));
  writeFileSync(join(directory, 'policy-contract.json'),
    `${JSON.stringify(createPolicyContract(readPolicyFiles(process.cwd())), null, 2)}\n`,
    { mode: 0o600 });
  copyFileSync(fileURLToPath(import.meta.url), join(directory, 'check-trusted-review-workflow.mjs'));
  appendFileSync(process.env.GITHUB_OUTPUT, `contract_dir=${directory}\n`, { mode: 0o600 });
}

function verifyBasePolicyContract(contractPath) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const result = verifyPolicyContract(contract, readPolicyFiles(process.cwd()));
  if (!result.passed) {
    for (const error of result.errors) console.error(`Trusted review policy contract failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Base-ref policy matches the trusted review contract.');
}

function assertTrustedWorkflowContract() {
  const source = readFileSync(WORKFLOW_URL, 'utf8');
  const result = checkTrustedReviewWorkflow(source);
  if (!result.passed) {
    for (const error of result.errors) console.error(`Trusted review workflow contract failed: ${error}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}
function indentOf(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function normalizeScalar(value) {
  return value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

function parseSteps(lines, start, end) {
  const steps = [];
  let current = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (/^      -(?:\s|$)/.test(line)) {
      if (current) steps.push(current);
      current = { lines: [line], index };
    } else if (current && (line.trim() === '' || indentOf(line) > 6)) {
      current.lines.push(line);
    }
  }
  if (current) steps.push(current);
  return steps;
}

function scalar(step, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = step.lines[0].match(new RegExp(`^ {6}-\\s+${escaped}:\\s*(.*?)\\s*$`));
  if (inline) return normalizeScalar(inline[1]);
  const match = step.lines.join('\n').match(new RegExp(`^ {8}${escaped}:\\s*(.*?)\\s*$`, 'm'));
  return match ? normalizeScalar(match[1]) : null;
}

function stepName(step) {
  const match = step.lines[0].match(/^      -\s+name:\s*(.*?)\s*$/);
  return match?.[1] ?? null;
}

function hasContinueOnError(step) {
  return step.lines.some((line) => /^ {8}["']?continue-on-error["']?\s*:/i.test(line));
}

function checkoutRef(step) {
  const withIndex = step.lines.findIndex((line) => /^ {8}with:\s*$/.test(line));
  if (withIndex < 0) return null;
  for (let index = withIndex + 1; index < step.lines.length; index += 1) {
    const line = step.lines[index];
    if (line.trim() !== '' && indentOf(line) <= 8) break;
    const match = line.match(/^ {10}ref:\s*(.*?)\s*$/);
    if (match) return match[1];
  }
  return null;
}

function checkoutRepository(step) {
  const withIndex = step.lines.findIndex((line) => /^ {8}with:\s*$/.test(line));
  if (withIndex < 0) return null;
  for (let index = withIndex + 1; index < step.lines.length; index += 1) {
    const line = step.lines[index];
    if (line.trim() !== '' && indentOf(line) <= 8) break;
    const match = line.match(/^ {10}repository:\s*(.*?)\s*$/);
    if (match) return match[1];
  }
  return null;
}

function getReviewJob(lines) {
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex < 0) return null;
  let jobsEnd = lines.length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && indentOf(lines[index]) === 0) {
      jobsEnd = index;
      break;
    }
  }
  const jobHeaders = [];
  for (let index = jobsIndex + 1; index < jobsEnd; index += 1) {
    const match = lines[index].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) jobHeaders.push({ name: match[1], index });
  }
  const review = jobHeaders.find((job) => job.name === 'review');
  if (!review || jobHeaders.length !== 1) return null;
  const jobEnd = jobHeaders[1]?.index ?? jobsEnd;
  const stepsIndex = lines.findIndex((line, index) => index > review.index && index < jobEnd && /^ {4}steps:\s*$/.test(line));
  if (stepsIndex < 0) return null;
  return {
    start: review.index,
    end: jobEnd,
    steps: parseSteps(lines, stepsIndex, jobEnd),
    lines: lines.slice(review.index, jobEnd),
  };
}

function workflowEvents(lines) {
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex < 0) return [];
  let end = lines.length;
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && indentOf(lines[index]) === 0) {
      end = index;
      break;
    }
  }
  return lines.slice(onIndex + 1, end)
    .map((line) => line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)?.[1])
    .filter(Boolean);
}

function workflowPermissions(lines) {
  const permissionsIndex = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (permissionsIndex < 0) return null;
  const permissions = {};
  for (let index = permissionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) === 0) break;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(read|write|none)\s*$/);
    if (match) permissions[match[1]] = match[2];
  }
  return permissions;
}

export function checkTrustedReviewWorkflow(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const errors = [];
  const add = (reason) => errors.push(reason);

  if (JSON.stringify(workflowEvents(lines)) !== JSON.stringify(['pull_request_target'])) {
    add('workflow must be triggered only by pull_request_target');
  }
  const expectedPermissions = {
    'pull-requests': 'write',
    'security-events': 'write',
    checks: 'write',
    contents: 'read',
  };
  const actualPermissions = workflowPermissions(lines);
  if (!actualPermissions || Object.keys(actualPermissions).length !== Object.keys(expectedPermissions).length ||
      Object.entries(expectedPermissions).some(([name, value]) => actualPermissions[name] !== value)) {
    add('workflow permissions must remain at the reviewed least-privilege set');
  }

  const job = getReviewJob(lines);
  if (!job) {
    add('workflow must contain exactly one review job with a steps block');
    return { passed: false, errors };
  }
  if (job.lines.some((line) => /^ {4}if:\s*/.test(line))) {
    add('review job must not be conditionally skipped');
  }

  const checkouts = job.steps.filter((step) => /^actions\/checkout@/i.test(scalar(step, 'uses') ?? ''));
  if (checkouts.length !== 2) {
    add(`review job must contain exactly two checkout steps; found ${checkouts.length}`);
  }
  for (const [index, step] of checkouts.entries()) {
    const uses = scalar(step, 'uses') ?? '';
    if (!/^actions\/checkout@[0-9a-f]{40}$/i.test(uses)) {
      add(`checkout ${index + 1} must pin actions/checkout to a full commit SHA`);
    }
    if (checkoutRepository(step) !== null) {
      add(`checkout ${index + 1} must use the trusted current repository`);
    }
  }
  if (checkouts[0] && checkoutRef(checkouts[0]) !== TRUSTED_WORKFLOW_REF) {
    add('first checkout ref must be github.workflow_sha');
  }
  if (checkouts[1] && checkoutRef(checkouts[1]) !== TRUSTED_BASE_REF) {
    add('second checkout ref must be the pull request base SHA');
  }

  const checkerSteps = job.steps.filter((step) =>
    (scalar(step, 'run') ?? '').trim() === CHECKER_COMMAND,
  );
  if (checkerSteps.length !== 1) {
    add('workflow must run the trusted workflow contract checker exactly once');
  } else {
    const checker = checkerSteps[0];
    const checkerIndex = job.steps.indexOf(checker);
    const generateTokenIndex = job.steps.findIndex((step) => stepName(step) === 'Generate commitperclip token');
    if (checkerIndex <= job.steps.indexOf(checkouts[0]) || generateTokenIndex < 0 || checkerIndex >= generateTokenIndex) {
      add('contract checker must run after trusted checkout and before token generation');
    }
    if (scalar(checker, 'if') !== null) {
      add('contract checker must not be conditionally skipped, including for fork pull requests');
    }
    if (hasContinueOnError(checker)) {
      add('contract checker must not allow errors to continue');
    }
  }

  const verifyPolicySteps = job.steps.filter((step) =>
    (scalar(step, 'run') ?? '').trim() === POLICY_VERIFY_COMMAND,
  );
  if (verifyPolicySteps.length !== 1) {
    add('workflow must verify the base-ref policy against the trusted policy contract exactly once');
  } else {
    const verifyStep = verifyPolicySteps[0];
    const verifyIndex = job.steps.indexOf(verifyStep);
    const baseCheckoutIndex = job.steps.indexOf(checkouts[1]);
    const forkPolicyIndex = job.steps.findIndex((step) => stepName(step) === 'Fork dependency change policy');
    if (verifyIndex <= baseCheckoutIndex || forkPolicyIndex < 0 || verifyIndex >= forkPolicyIndex) {
      add('base policy contract must be verified after base checkout and before policy execution');
    }
    if (scalar(verifyStep, 'if') !== null) {
      add('base policy contract verification must not be conditionally skipped');
    }
    if (hasContinueOnError(verifyStep)) {
      add('base policy contract verification must not allow errors to continue');
    }
  }

  const forkPolicy = job.steps.find((step) => stepName(step) === 'Fork dependency change policy');
  if (!forkPolicy || scalar(forkPolicy, 'if') !== '${{ github.event.repository.fork }}') {
    add('fork dependency policy must remain enabled only for fork pull requests');
  }
  const dependencyReview = job.steps.find((step) => stepName(step) === 'Dependency Review');
  if (!dependencyReview || scalar(dependencyReview, 'if') !== '${{ !github.event.repository.fork }}') {
    add('Dependency Review must remain enabled only for non-fork pull requests');
  }

  return { passed: errors.length === 0, errors };
}

function main() {
  const [mode, path] = process.argv.slice(2);
  if (mode === '--record-policy-contract' && process.argv.length === 4) {
    if (assertTrustedWorkflowContract()) recordPolicyContract(path);
    return;
  }
  if (mode === '--verify-policy-contract' && process.argv.length === 4) {
    verifyBasePolicyContract(path);
    return;
  }
  if (process.argv.length !== 2) {
    throw new Error('Expected no arguments, --record-policy-contract <absolute-dir>, or --verify-policy-contract <path>.');
  }
  if (!assertTrustedWorkflowContract()) return;
  console.log('Trusted review workflow contract passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Trusted review workflow contract could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
