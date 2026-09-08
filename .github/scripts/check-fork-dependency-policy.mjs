#!/usr/bin/env node
/**
 * Fail-closed dependency-change policy for GitHub forks.
 *
 * GitHub's Dependency Review API rejects fork repositories. On a fork, any
 * dependency-bearing file change therefore requires the trusted maintainer
 * label `dependency-review-approved`. PR authors cannot supply this process
 * environment; the pull_request_target workflow owns it and executes only the
 * trusted base-branch copy of this script.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';

export const DEPENDENCY_APPROVAL_LABEL = 'dependency-review-approved';

export function isDependencyBearingPath(filename) {
  const normalized = filename.replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1);
  return basename === 'package.json' ||
    basename === 'package-lock.json' ||
    basename === 'npm-shrinkwrap.json' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'pnpm-workspace.yaml' ||
    basename === 'yarn.lock' ||
    basename === 'bun.lock' ||
    basename === 'bun.lockb' ||
    normalized.startsWith('patches/');
}

function normalizeLabels(labels) {
  return labels.map((label) => typeof label === 'string' ? label : label?.name)
    .filter(Boolean);
}

export function checkForkDependencyPolicy(files, labels = []) {
  const dependencyFiles = files
    .filter((file) => isDependencyBearingPath(file.filename))
    .map((file) => file.filename)
    .sort();

  if (dependencyFiles.length === 0) {
    return { passed: true, dependencyFiles: [], approvalLabel: DEPENDENCY_APPROVAL_LABEL };
  }

  if (normalizeLabels(labels).includes(DEPENDENCY_APPROVAL_LABEL)) {
    return { passed: true, dependencyFiles, approvalLabel: DEPENDENCY_APPROVAL_LABEL };
  }

  return {
    passed: false,
    dependencyFiles,
    approvalLabel: DEPENDENCY_APPROVAL_LABEL,
    reason: `Dependency-bearing files changed without the trusted ${DEPENDENCY_APPROVAL_LABEL} label.`,
  };
}

function parseFixtureJson(name) {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array.`);
  return value;
}

async function main() {
  const fixtureFiles = parseFixtureJson('PR_FILES_JSON');
  const fixtureLabels = parseFixtureJson('PR_LABELS_JSON');
  let files;
  let labels;

  if (fixtureFiles !== null || fixtureLabels !== null) {
    if (fixtureFiles === null || fixtureLabels === null) {
      throw new Error('PR_FILES_JSON and PR_LABELS_JSON must be supplied together.');
    }
    files = fixtureFiles;
    labels = fixtureLabels;
  } else {
    const { GH_TOKEN, GH_REPO, PR_NUMBER } = process.env;
    const prNumber = Number.parseInt(PR_NUMBER ?? '', 10);
    if (!GH_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GH_REPO ?? '')) {
      throw new Error('GH_TOKEN and a valid GH_REPO are required.');
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error('PR_NUMBER must be a positive integer.');
    }

    [files, { labels = [] }] = await Promise.all([
      fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
      ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    ]);
  }

  const result = checkForkDependencyPolicy(files, labels);
  console.log(JSON.stringify(result));
  if (!result.passed) {
    console.error(result.reason);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
