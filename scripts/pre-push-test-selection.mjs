#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[mc]?[jt]sx?$/i;
const SOURCE_FILE_PATTERN = /\.[mc]?[jt]sx?$/i;
const GENERATED_PATH_PATTERN = /(^|\/)generated(\/|$)|\.generated\.[mc]?[jt]sx?$/i;
const NODE_TEST_PATTERN = /^(?:scripts\/.*\.test\.mjs|\.github\/scripts\/tests\/.*\.test\.mjs)$/i;
const PLAYWRIGHT_TEST_PATTERN = /^tests\/(?:e2e|release-smoke|storybook-visual)\/.*\.spec\.[mc]?[jt]s$/i;

const ROOT_VITEST_PROJECTS = [
  "server",
  "ui",
  "cli",
  "packages/shared",
  "packages/skills-catalog",
  "packages/db",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/cursor-cloud",
  "packages/adapters/cursor-local",
  "packages/adapters/gemini-local",
  "packages/adapters/grok-local",
  "packages/adapters/openclaw-gateway",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
  "packages/plugins/sdk",
  "packages/plugins/create-paperclip-plugin",
];

const HOSTED_CI_PATH_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.husky\//,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)vitest(?:\.workspace|\.config)?\.[mc]?[jt]s$/,
  /(^|\/)playwright\.config\.[mc]?[jt]s$/,
  /^scripts\/pre-push-check\.(?:ps1|sh)$/,
  /^scripts\/(?:run-vitest-stable|run-pre-push-tests|pre-push-test-selection)\.mjs$/,
];

const NON_PRODUCTION_PATH_PATTERNS = [
  /(?:^|\/)(?:README|CHANGELOG|OPEN_TASKS|LICENSE|AUTHORING)(?:\.[^/]*)?$/i,
  /^[^/]+\.md$/i,
  /^(?:doc|docs)\//,
];

// Some suites intentionally exercise production code through a higher-level
// contract test whose name cannot be derived from the source filename. Keep
// those exceptions explicit and exact instead of widening test discovery to
// an unbounded import-graph scan.
const DECLARED_SOURCE_TESTS = new Map([
  [
    "tests/e2e/onboarding-hire-route.ts",
    ["tests/e2e/onboarding-hire-route.spec.ts"],
  ],
  [
    "scripts/lib/pr45-disposition-policy.mjs",
    ["scripts/generate-pr45-disposition-manifest.test.mjs"],
  ],
  [
    "scripts/lib/unified-zero-patch.mjs",
    ["scripts/generate-pr45-disposition-manifest.test.mjs"],
  ],
  [
    "server/src/middleware/http-logger.ts",
    ["server/src/__tests__/http-log-redaction.test.ts"],
  ],
  [
    "ui/src/hooks/useOnboardingAgentConfigReview.ts",
    ["ui/src/components/OnboardingWizard.config-persistence.test.tsx"],
  ],
  [
    "ui/src/hooks/usePersistOnboardingAgentConfig.ts",
    ["ui/src/components/OnboardingWizard.config-persistence.test.tsx"],
  ],
]);

export class TestSelectionIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestSelectionIntegrityError";
  }
}

export function normalizeRepoPath(file) {
  if (typeof file !== "string" || file.includes("\0")) {
    throw new TestSelectionIntegrityError("changed paths must be non-null strings");
  }
  if (file.trim() !== file) {
    throw new TestSelectionIntegrityError(`changed path contains surrounding whitespace: ${file}`);
  }
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "" ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new TestSelectionIntegrityError(`changed path escapes the repository: ${file}`);
  }
  return normalized;
}

export function isTestFile(file) {
  return TEST_FILE_PATTERN.test(normalizeRepoPath(file));
}

export function isTestBearingProductionFile(file) {
  const normalized = normalizeRepoPath(file);
  if (!SOURCE_FILE_PATTERN.test(normalized) || isTestFile(normalized) || /\.d\.[mc]?ts$/i.test(normalized)) {
    return false;
  }
  if (GENERATED_PATH_PATTERN.test(normalized)) return false;
  if (DECLARED_SOURCE_TESTS.has(normalized)) return true;
  return (
    /^(?:server|ui|cli)\/src\//.test(normalized) ||
    /^packages\/.+\/src\//.test(normalized) ||
    /^scripts\/.+\.[mc]?[jt]sx?$/i.test(normalized) ||
    /^\.github\/scripts\/.+\.[mc]?[jt]sx?$/i.test(normalized)
  );
}

export function classifyTestRunner(file) {
  const normalized = normalizeRepoPath(file);
  if (NODE_TEST_PATTERN.test(normalized)) return "node-test";
  if (PLAYWRIGHT_TEST_PATTERN.test(normalized)) return "hosted-playwright";
  if (
    ROOT_VITEST_PROJECTS.some(
      (projectRoot) => normalized === projectRoot || normalized.startsWith(`${projectRoot}/`),
    )
  ) {
    return "vitest";
  }
  return "hosted-unregistered";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPathInsideRepo(repoRoot, absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TestSelectionIntegrityError(`test discovery escaped the repository: ${absolutePath}`);
  }
}

function normalizeNativePath(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveWithoutSymlink(repoRoot, relativePath, absolutePath) {
  let realPath;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    throw new TestSelectionIntegrityError(
      `cannot resolve ${relativePath}: ${error?.code ?? error?.message}`,
    );
  }
  assertPathInsideRepo(repoRoot, realPath);
  if (normalizeNativePath(realPath) !== normalizeNativePath(absolutePath)) {
    throw new TestSelectionIntegrityError(
      `symbolic-link traversal is not valid for test selection: ${relativePath}`,
    );
  }
  return realPath;
}

function readPathKind(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  assertPathInsideRepo(repoRoot, absolutePath);
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw new TestSelectionIntegrityError(
      `cannot inspect ${relativePath}: ${error?.code ?? error?.message}`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new TestSelectionIntegrityError(`symbolic links are not valid test-selection inputs: ${relativePath}`);
  }
  resolveWithoutSymlink(repoRoot, relativePath, absolutePath);
  return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "unsupported";
}

function discoverSiblingTests(repoRoot, sourceFile) {
  const normalized = normalizeRepoPath(sourceFile);
  const sourceDirectory = path.posix.dirname(normalized);
  const parentDirectory = path.posix.dirname(sourceDirectory);
  const sourceStem = path.posix.basename(normalized).replace(SOURCE_FILE_PATTERN, "");
  const candidateName = new RegExp(
    `^${escapeRegExp(sourceStem)}(?:[.-].*)?\\.(?:test|spec)\\.[mc]?[jt]sx?$`,
    "i",
  );
  const candidateDirectories = new Set([
    sourceDirectory,
    `${sourceDirectory}/__tests__`,
    `${sourceDirectory}/tests`,
    parentDirectory,
    `${parentDirectory}/__tests__`,
    `${parentDirectory}/tests`,
  ]);
  const matches = [];

  for (const relativeDirectory of candidateDirectories) {
    if (relativeDirectory === ".") continue;
    const kind = readPathKind(repoRoot, relativeDirectory);
    if (kind === "absent") continue;
    if (kind !== "directory") {
      throw new TestSelectionIntegrityError(`test candidate path is not a directory: ${relativeDirectory}`);
    }
    const absoluteDirectory = path.resolve(repoRoot, relativeDirectory);
    resolveWithoutSymlink(repoRoot, relativeDirectory, absoluteDirectory);
    let entries;
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      throw new TestSelectionIntegrityError(
        `cannot list test candidate directory ${relativeDirectory}: ${error?.code ?? error?.message}`,
      );
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new TestSelectionIntegrityError(
          `symbolic link in test candidate directory is not allowed: ${relativeDirectory}/${entry.name}`,
        );
      }
      if (!entry.isFile() || !candidateName.test(entry.name)) continue;
      matches.push(normalizeRepoPath(path.posix.join(relativeDirectory, entry.name)));
    }
  }

  return matches.sort();
}

function discoverDeclaredTests(repoRoot, sourceFile) {
  const declaredTests = DECLARED_SOURCE_TESTS.get(normalizeRepoPath(sourceFile)) ?? [];
  const matches = [];
  const errors = [];

  for (const declaredTest of declaredTests) {
    const normalizedTest = normalizeRepoPath(declaredTest);
    const kind = readPathKind(repoRoot, normalizedTest);
    if (kind !== "file") {
      errors.push(
        `declared deterministic test is not a regular file: ${sourceFile} -> ${normalizedTest}`,
      );
      continue;
    }
    matches.push(normalizedTest);
  }

  return { tests: matches.sort(), errors };
}

function isHostedCiPath(file) {
  if (NON_PRODUCTION_PATH_PATTERNS.some((pattern) => pattern.test(file))) return false;
  if (HOSTED_CI_PATH_PATTERNS.some((pattern) => pattern.test(file))) return true;
  return !isTestFile(file) && !isTestBearingProductionFile(file);
}

export function selectPrePushTests({ repoRoot, changedFiles, trackedFiles }) {
  if (!Array.isArray(changedFiles)) {
    throw new TestSelectionIntegrityError("changed files must be supplied as an array");
  }
  if (!(trackedFiles instanceof Set)) {
    throw new TestSelectionIntegrityError(
      "tracked files from the pushed HEAD are required for deterministic test selection",
    );
  }
  const normalizedChanges = [...new Set(changedFiles.map(normalizeRepoPath))].sort();
  if (normalizedChanges.length === 0) {
    throw new TestSelectionIntegrityError("the push contains no resolvable changed paths");
  }

  const changedTestFiles = [];
  const removedTestFiles = [];
  for (const file of normalizedChanges.filter(isTestFile)) {
    const kind = readPathKind(repoRoot, file);
    if (kind === "absent") removedTestFiles.push(file);
    else if (kind === "file") changedTestFiles.push(file);
    else throw new TestSelectionIntegrityError(`changed test is not a regular file: ${file}`);
  }

  const productionFiles = normalizedChanges.filter(isTestBearingProductionFile);
  const selected = new Set(changedTestFiles);
  const coverage = [];
  const uncoveredProductionFiles = [];
  const removedProductionFiles = [];
  const declaredCoverageErrors = [];
  for (const sourceFile of productionFiles) {
    const sourceKind = readPathKind(repoRoot, sourceFile);
    if (sourceKind !== "absent" && sourceKind !== "file") {
      throw new TestSelectionIntegrityError(`changed production path is not a regular file: ${sourceFile}`);
    }
    const siblingTests = discoverSiblingTests(repoRoot, sourceFile);
    const declared = discoverDeclaredTests(repoRoot, sourceFile);
    const deterministicTests = [...new Set([...siblingTests, ...declared.tests])].sort();
    coverage.push({
      sourceFile,
      sourceRemoved: sourceKind === "absent",
      siblingTests,
      declaredTests: declared.tests,
    });
    declaredCoverageErrors.push(...declared.errors);
    if (sourceKind === "absent") removedProductionFiles.push(sourceFile);
    else if (deterministicTests.length === 0) uncoveredProductionFiles.push(sourceFile);
    deterministicTests.forEach((file) => selected.add(file));
  }

  const vitestFiles = [];
  const nodeTestFiles = [];
  const hostedTestFiles = [];
  for (const file of [...selected].sort()) {
    const runner = classifyTestRunner(file);
    if (runner === "vitest") vitestFiles.push(file);
    else if (runner === "node-test") nodeTestFiles.push(file);
    else hostedTestFiles.push(file);
  }

  const hostedCiFiles = [...new Set([
    ...normalizedChanges.filter(isHostedCiPath),
    ...hostedTestFiles,
    ...removedTestFiles,
    ...removedProductionFiles.filter(
      (file) => !coverage.some(
        (item) => item.sourceFile === file
          && (item.siblingTests.length > 0 || item.declaredTests.length > 0),
      ),
    ),
  ])].sort();
  const nonProductionFiles = normalizedChanges.filter(
    (file) => NON_PRODUCTION_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
  const selectionErrors = [
    ...uncoveredProductionFiles.map(
      (file) => `test-bearing production file lacks a deterministic sibling or declared test: ${file}`,
    ),
    ...declaredCoverageErrors,
    ...[...selected]
      .filter((file) => !trackedFiles.has(file))
      .map((file) => `selected test is not tracked in the pushed HEAD: ${file}`),
  ];

  return {
    mode: "exact-runner-aware-tests",
    changedFiles: normalizedChanges,
    changedTestFiles,
    removedTestFiles,
    productionFiles,
    removedProductionFiles,
    coverage,
    selectedTests: [...selected].sort(),
    vitestFiles,
    nodeTestFiles,
    hostedTestFiles,
    hostedCiFiles,
    nonProductionFiles,
    uncoveredProductionFiles,
    selectionErrors,
  };
}
