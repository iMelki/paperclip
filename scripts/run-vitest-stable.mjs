#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveGitLocalEnvironmentVariableNames,
  sanitizeGitLocalEnvironment,
} from "./git-local-env.mjs";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { forEachExactVitestFile, runVitestDirect } from "./run-vitest-direct.mjs";

const repoRoot = process.cwd();
const gitLocalEnvironmentVariableNames = resolveGitLocalEnvironmentVariableNames({ cwd: repoRoot });
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
const commonVitestArgs = [
  "--testTimeout=30000",
  "--hookTimeout=30000",
  "--teardownTimeout=30000",
  "--reporter=default",
  "--reporter=hanging-process",
];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;
  let related = false;
  let exact = false;
  const relatedFiles = [];
  const exactFiles = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--related") {
      related = true;
      continue;
    }

    if (arg === "--files") {
      exact = true;
      continue;
    }

    // Once --related is set, bare arguments are the changed source files to trace.
    if (related && !arg.startsWith("--")) {
      relatedFiles.push(arg);
      continue;
    }

    if (exact && !arg.startsWith("--")) {
      exactFiles.push(arg);
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (related && exact) {
    fail("--related and --files are mutually exclusive.");
  }

  if (related) {
    if (mode !== allModeName || group !== null || shardIndex !== null || shardCount !== null || dryRun) {
      fail("--related cannot be combined with --mode/--group/--shard-*/--dry-run.");
    }
    return {
      mode,
      shardIndex: null,
      shardCount: null,
      group: null,
      dryRun: false,
      related,
      relatedFiles,
      exact: false,
      exactFiles: [],
    };
  }

  if (exact) {
    if (mode !== allModeName || group !== null || shardIndex !== null || shardCount !== null || dryRun) {
      fail("--files cannot be combined with --mode/--group/--shard-*/--dry-run.");
    }
    if (exactFiles.length === 0) fail("--files requires at least one exact test path.");
    return {
      mode,
      shardIndex: null,
      shardCount: null,
      group: null,
      dryRun: false,
      related: false,
      relatedFiles: [],
      exact,
      exactFiles,
    };
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  return routeTests.filter((_, index) => index % shardCount === shardIndex);
}

function runVitest(args, label, { serverExcludes = [], subcommand = "run" } = {}) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = sanitizeGitLocalEnvironment({
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE:
      process.env.PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE ?? "true",
    TMPDIR: path.join(testRoot, "t"),
  }, gitLocalEnvironmentVariableNames);
  delete env.PAPERCLIP_VITEST_EXCLUDE_FILE;
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  if (serverExcludes.length > 0) {
    const excludeFile = path.join(testRoot, "server-excludes.json");
    writeFileSync(excludeFile, `${JSON.stringify(serverExcludes)}\n`, "utf8");
    env.PAPERCLIP_VITEST_EXCLUDE_FILE = excludeFile;
  }
  const result = runVitestDirect([subcommand, ...commonVitestArgs, ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    runGeneralGroup(routeTests, groupName);
  }
}

function runProjectGroup(projects, groupName) {
  for (const project of projects) {
    runVitest(["--project", project], `${groupName} project ${project}`);
  }
}

function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        generalServerTestFiles,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      runVitest(
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
      { serverExcludes: routeTests.map((file) => file.serverPath) },
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    runProjectGroup(generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

/**
 * Run only the suites whose module graph reaches one of `files`.
 *
 * This backs the pre-commit hook's fast path. It runs across every vitest project (no
 * `--project` filter) so a changed package pulls in its consumers' suites too, and it reuses
 * `runVitest` so related runs get the same isolated PAPERCLIP_HOME/TMPDIR sandbox the full
 * lanes get — running bare `vitest related` would leak the developer's real paperclip home
 * into the suites.
 *
 * Related-set resolution uses `passWithNoTests`: most commits touch files no suite imports,
 * and Vitest must return an empty set rather than reject every such commit. Execution starts
 * only after the resolver returns one or more concrete suite paths.
 *
 * The selection is run under the same isolation the serialized lane hand-rolls
 * (`runSerializedSuites` spawns one vitest per route/authz suite). A related selection can pull
 * route/authz suites and general suites into one invocation, and those suites are not safe to
 * share a Vitest process — batching them produced environment and mock leakage that vanished
 * when the same suites ran apart. Every selected file therefore gets a separate Vitest process;
 * worker isolation flags alone are insufficient because the coordinator process also owns
 * mutable test-environment state.
 */
/**
 * Default ceiling on how many suites a single pre-commit related run may execute.
 *
 * Rationale: `vitest related` is honest about the import graph, and that is exactly the
 * problem. Server suites import the app, and the app imports ~everything, so almost any
 * `server/src` change is a "hub" change. Measured on this repo (2026-08-12):
 *
 *   server/src/services/heartbeat.ts                    159 of 1130 specs
 *   server/src/services/execution-allowlist.ts          160 of 1130 specs
 *   packages/adapter-utils/src/sandbox-managed-runtime.ts  288 of 1130 specs
 *   ui/src/lib/activity-format.ts                         9 of 1130 specs  (a genuine leaf)
 *
 * A capped run of 25 server suites measured 673.9s wall, of which 618.5s was module IMPORT
 * and only 28.0s was test execution — i.e. cost is ~27s per suite and scales linearly with
 * the count, so 159 suites extrapolates to ~70 minutes. Uncapped, the hook silently degrades
 * into the full sweep it was introduced to avoid.
 *
 * 12 keeps a hub-module commit near a ~5 minute test budget while leaving genuine leaf changes
 * (the common case) completely untouched — they select fewer suites than the cap and still run
 * their full related set.
 *
 * This inverts the usual test-impact-analysis convention (Azure DevOps / Datadog / Google all
 * fall back to running MORE tests when selection is untrustworthy). That is deliberate: those
 * systems' selection guards a MERGE. This one guards a local commit, and it is not the
 * approximate local gate. Pre-push runs deterministic exact changed/sibling suites, while
 * pull requests into dev and master run the exhaustive hosted lanes. Correctness gates
 * (forbidden tokens, gitleaks, react-doctor, typecheck) are untouched by this cap.
 *
 * HARD PRECONDITION: this cap is only safe when pre-push actually dispatches and hosted PR CI
 * covers the target branch. A missing .husky/pre-push is indistinguishable from a pass, so
 * "no output" is not evidence. Resolve core.hooksPath and verify its dispatcher plus the
 * repository .husky/pre-push target.
 *
 * Override with PAPERCLIP_PRECOMMIT_RELATED_CAP (0 disables the cap and restores the
 * uncapped related run).
 */
const defaultRelatedSuiteCap = 12;

function resolveRelatedSuiteCap() {
  const raw = process.env.PAPERCLIP_PRECOMMIT_RELATED_CAP;
  if (raw === undefined || raw === "") return defaultRelatedSuiteCap;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`PAPERCLIP_PRECOMMIT_RELATED_CAP must be a non-negative integer; got "${raw}".`);
  }
  return parsed;
}

/**
 * Resolve the suites vitest's `related` selection would run, WITHOUT running them.
 *
 * Uses vitest's Node API so the cap can be applied before any test process is spawned. This
 * builds the module graph once (~70s on this repo); the selected files are then handed to a
 * normal `vitest run`, so the graph is not rebuilt by a second `vitest related` invocation.
 *
 * Resolution only globs and traces imports — it never executes a suite, so it does not need
 * the isolated PAPERCLIP_HOME/TMPDIR sandbox that `runVitest` sets up for execution.
 */
async function resolveRelatedSpecFiles(files) {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    related: files,
    passWithNoTests: true,
  });
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    const unique = new Set();
    for (const spec of specs) {
      if (spec.moduleId) unique.add(toRepoPath(spec.moduleId));
    }
    return [...unique].sort();
  } finally {
    await vitest.close();
  }
}

/**
 * Rank selected suites by proximity to the changed files, then keep the first `cap`.
 *
 * Proximity beats arbitrary truncation: a change's own co-located suite is the one most likely
 * to catch the regression, and it keeps the subset deterministic (stable ordering => the same
 * commit always runs the same suites, so a green hook is reproducible).
 *
 * Tier 0: the changed file IS a suite (always run — never drop a directly staged test).
 * Tier 1: suite lives in the same directory as a changed file.
 * Tier 2: suite shares the changed file's workspace package (first two path segments).
 * Tier 3: everything else, alphabetically.
 */
function selectRepresentativeSuites(specFiles, changedFiles, cap) {
  const changed = new Set(changedFiles.map((file) => toRepoPath(path.resolve(repoRoot, file))));
  const changedDirs = new Set([...changed].map((file) => path.posix.dirname(file)));
  const packageOf = (file) => file.split("/").slice(0, 2).join("/");
  const changedPackages = new Set([...changed].map(packageOf));

  const tierOf = (file) => {
    if (changed.has(file)) return 0;
    if (changedDirs.has(path.posix.dirname(file))) return 1;
    if (changedPackages.has(packageOf(file))) return 2;
    return 3;
  };

  return [...specFiles]
    .sort((left, right) => tierOf(left) - tierOf(right) || left.localeCompare(right))
    .slice(0, cap);
}

async function runRelatedSuites(files) {
  if (files.length === 0) {
    console.log("\n[test:run] related mode: no candidate source files; nothing to run.");
    return;
  }

  const cap = resolveRelatedSuiteCap();
  console.log(`\n[test:run] resolving suites related to ${files.length} changed file(s)...`);
  const selected = await resolveRelatedSpecFiles(files);
  if (selected.length === 0) {
    console.log("[test:run] related mode: no suite imports the changed files; nothing to run.");
    return;
  }

  if (cap === 0) {
    runRelatedFilesIndependently(
      selected,
      `uncapped related selection for ${files.length} changed file(s)`,
    );
    return;
  }

  if (selected.length <= cap) {
    runRelatedFilesIndependently(
      selected,
      `related to ${files.length} changed file(s): ${selected.length} suite(s)`,
    );
    return;
  }

  const subset = selectRepresentativeSuites(selected, files, cap);
  console.log(
    `\n[test:run] ${selected.length} suites import the staged files (cap ${cap}). ` +
      `The staged change reaches a hub module, so the related set has degenerated toward the ` +
      `full suite.\n` +
      `[test:run] Running the ${subset.length} suites closest to the change locally. ` +
      `Pre-push runs exact changed/sibling suites without import-graph expansion, and ` +
      `pull requests into dev or master run the exhaustive hosted lanes.\n` +
      `[test:run] For a full local sweep before pushing: PAPERCLIP_PRECOMMIT_ALL=1 git commit ...` +
      ` (or PAPERCLIP_PRECOMMIT_RELATED_CAP=0 to run all ${selected.length}).`,
  );
  runRelatedFilesIndependently(
    subset,
    `related subset: ${subset.length} of ${selected.length} suite(s)`,
  );
}

function runRelatedFilesIndependently(files, label) {
  forEachExactVitestFile(files, (file) => {
    runVitest(
      ["--pool=forks", "--isolate", ...serializedServerVitestArgs, file],
      `${label}: ${file}`,
    );
  });
}

function runExactSuites(files) {
  const invalid = files.filter((file) => !/\.(?:test|spec)\.[mc]?[jt]sx?$/i.test(file));
  if (invalid.length > 0) {
    fail(`--files accepts only exact test paths; received: ${invalid.join(", ")}`);
  }
  // Run each exact file separately. Some workspace projects deliberately include
  // only *.test.ts while others include *.spec.ts; one accepted file must never
  // let an excluded file disappear behind an otherwise successful invocation.
  forEachExactVitestFile(files, (file) => {
    runVitest(
      ["--pool=forks", "--isolate", ...serializedServerVitestArgs, file],
      `exact pre-push selection: ${file}`,
    );
  });
}

function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  for (const routeTest of shardTests) {
    runVitest(
      [
        "--project",
        "@paperclipai/server",
        routeTest.repoPath,
        "--pool=forks",
        "--isolate",
      ],
      routeTest.repoPath,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. Sharding this list across runners is what keeps
// the general-server lane from becoming the PR critical path: the server vitest
// config pins maxWorkers to 1, so the only way to parallelize is across jobs.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const generalServerTestFiles = walk(serverSrcDir)
  .map((file) => toRepoPath(file))
  .filter((repoPath) => repoPath.endsWith(".test.ts"))
  .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
  .sort((a, b) => a.localeCompare(b));

const options = parseCliOptions(process.argv.slice(2));
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: generalGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          options.mode === generalModeName &&
          options.group === generalServerGroupName &&
          options.shardCount !== null
            ? selectGeneralServerShard(
                generalServerTestFiles,
                options.shardIndex,
                options.shardCount,
                generalServerShardDurations,
              )
            : null,
        generalServerExclusionTransport: {
          kind: "config-file",
          excludeCount: routeTests.length,
          commandArgs: [
            "--project",
            "@paperclipai/server",
            ...serializedServerVitestArgs,
          ],
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (options.related) {
  // Top-level await: resolving the related set needs vitest's async Node API.
  await runRelatedSuites(options.relatedFiles);
  process.exit(0);
}

if (options.exact) {
  runExactSuites(options.exactFiles);
  process.exit(0);
}

if (options.mode === generalModeName || options.mode === allModeName) {
  if (options.group) {
    runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
  } else {
    runGeneralSuites(routeTests);
  }
}

if (options.mode === serializedModeName || options.mode === allModeName) {
  runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
}
