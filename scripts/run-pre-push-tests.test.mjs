import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createEphemeralDir } from "./lib/ephemeral-scratch.mjs";
import { fileURLToPath } from "node:url";

import {
  PrePushIntegrityError,
  TEST_CHILD_MAX_BUFFER,
  TEST_CHILD_TIMEOUT_MS,
  assertAdvertisedDevAncestor,
  assertPushMatchesWorkingTree,
  executeTestPlan,
  listChangedWorkflowFiles,
  parsePushUpdates,
  readHeadTrackedFiles,
  resolveOutgoingChangedFiles,
  runGit,
} from "./run-pre-push-tests.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ZERO = "0".repeat(40);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerScript = path.join(repoRoot, "scripts", "run-pre-push-tests.mjs");

function runScratchGit(scratchRoot, args) {
  const result = spawnSync("git", args, {
    cwd: scratchRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("parses the real four-field pre-push protocol and rejects empty or malformed input", () => {
  assert.deepEqual(
    parsePushUpdates(`refs/heads/topic ${A} refs/heads/topic ${ZERO}\n`),
    [{
      localRef: "refs/heads/topic",
      localOid: A,
      remoteRef: "refs/heads/topic",
      remoteOid: ZERO,
      deletion: false,
      creation: true,
    }],
  );
  assert.deepEqual(
    parsePushUpdates(`HEAD ${A} refs/heads/topic ${ZERO}\n`),
    [{
      localRef: "HEAD",
      localOid: A,
      remoteRef: "refs/heads/topic",
      remoteOid: ZERO,
      deletion: false,
      creation: true,
    }],
  );
  assert.throws(() => parsePushUpdates(""), /no pre-push ref updates/);
  assert.throws(
    () => parsePushUpdates(`refs/heads/topic ${A} refs/heads/topic\n`),
    /must contain four fields/,
  );
  assert.deepEqual(
    parsePushUpdates(`(delete) ${ZERO} refs/heads/old ${A}\n`),
    [{
      localRef: "(delete)",
      localOid: ZERO,
      remoteRef: "refs/heads/old",
      remoteOid: A,
      deletion: true,
      creation: false,
    }],
  );
  assert.throws(
    () => parsePushUpdates(`refs/heads/old ${ZERO} refs/heads/old ${A}\n`),
    /invalid local ref/,
  );
});

test("an existing topic ref uses authoritative dev as its exact test baseline", () => {
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "remote") return "git@example.test:paperclip.git\n";
    if (args[0] === "ls-remote") return `${C}\trefs/heads/dev\n`;
    if (args[0] === "merge-base") return "";
    return Buffer.from("server/src/a.ts\0server/src/a.test.ts\0");
  };
  const changed = resolveOutgoingChangedFiles({
    repoRoot: "C:/repo",
    remoteName: "origin",
    remoteLocation: "git@example.test:paperclip.git",
    updates: parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`),
    git,
  });
  assert.deepEqual(changed, ["server/src/a.test.ts", "server/src/a.ts"]);
  assert.deepEqual(calls, [
    ["remote", "get-url", "--push", "--all", "origin"],
    [
      "ls-remote", "--refs", "--heads", "--exit-code", "--",
      "git@example.test:paperclip.git", "refs/heads/dev",
    ],
    ["merge-base", "--is-ancestor", C, B],
    ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACDMRTUXB", C, B, "--"],
  ]);
});

test("a real Git rename reports both deleted and added paths", () => {
  const createdRoot = createEphemeralDir({ owner: "paperclip", purpose: "renametest" });
  const scratchRoot = realpathSync(createdRoot);
  try {
    runScratchGit(scratchRoot, ["init"]);
    runScratchGit(scratchRoot, ["config", "user.name", "iMelki"]);
    runScratchGit(scratchRoot, ["config", "user.email", "iMelki@users.noreply.github.com"]);
    mkdirSync(path.join(scratchRoot, "server", "src"), { recursive: true });
    writeFileSync(path.join(scratchRoot, "server", "src", "old.ts"), "export const value = 1;\n");
    runScratchGit(scratchRoot, ["add", "server/src/old.ts"]);
    runScratchGit(scratchRoot, ["commit", "-m", "test: add old path"]);
    const baseOid = runScratchGit(scratchRoot, ["rev-parse", "HEAD"]);
    renameSync(
      path.join(scratchRoot, "server", "src", "old.ts"),
      path.join(scratchRoot, "server", "src", "new.ts"),
    );
    runScratchGit(scratchRoot, ["add", "server/src/old.ts", "server/src/new.ts"]);
    runScratchGit(scratchRoot, ["commit", "-m", "test: rename source path"]);
    const headOid = runScratchGit(scratchRoot, ["rev-parse", "HEAD"]);
    runScratchGit(scratchRoot, ["remote", "add", "origin", "https://example.test/paperclip.git"]);

    const changed = resolveOutgoingChangedFiles({
      repoRoot: scratchRoot,
      remoteName: "origin",
      remoteLocation: "https://example.test/paperclip.git",
      updates: parsePushUpdates(
        `refs/heads/topic ${headOid} refs/heads/topic ${baseOid}\n`,
      ),
      git: (root, args, options) => args[0] === "ls-remote"
        ? `${baseOid}\trefs/heads/dev\n`
        : runGit(root, args, options),
    });
    assert.deepEqual(changed, ["server/src/new.ts", "server/src/old.ts"]);
  } finally {
    // Preserve the fixture for the existing scratch custodian.
  }
});

test("a new branch uses the authoritative remote dev object as its exact base", () => {
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "remote") return "git@example.test:paperclip.git\n";
    if (args[0] === "ls-remote") return `${A}\trefs/heads/dev\n`;
    if (args[0] === "merge-base") return "";
    if (args[0] === "diff") return Buffer.from("server/src/b.ts\0server/src/a.ts\0");
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  const changed = resolveOutgoingChangedFiles({
    repoRoot: "C:/repo",
    remoteName: "origin",
    remoteLocation: "git@example.test:paperclip.git",
    updates: parsePushUpdates(`refs/heads/topic ${C} refs/heads/topic ${ZERO}\n`),
    git,
  });
  assert.deepEqual(changed, ["server/src/a.ts", "server/src/b.ts"]);
  assert.deepEqual(calls[0], ["remote", "get-url", "--push", "--all", "origin"]);
  assert.deepEqual(calls[1], [
    "ls-remote", "--refs", "--heads", "--exit-code", "--",
    "git@example.test:paperclip.git", "refs/heads/dev",
  ]);
  assert.deepEqual(calls[2], ["merge-base", "--is-ancestor", A, C]);
  assert.deepEqual(calls[3], [
    "diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACDMRTUXB", A, C, "--",
  ]);
});

test("pushed-ref ancestry distinguishes divergence from Git execution failure", () => {
  assert.throws(
    () => assertAdvertisedDevAncestor({
      repoRoot: "C:/repo",
      remoteDevOid: A,
      localOid: C,
      remoteRef: "refs/heads/new",
      git: () => { throw new PrePushIntegrityError("git merge-base failed with exit 1", { exitCode: 1 }); },
    }),
    /pushed ref refs\/heads\/new must contain advertised refs\/heads\/dev object/,
  );
  const original = new PrePushIntegrityError("git merge-base failed with exit 128", { exitCode: 128 });
  assert.throws(
    () => assertAdvertisedDevAncestor({
      repoRoot: "C:/repo",
      remoteDevOid: A,
      localOid: C,
      remoteRef: "refs/heads/new",
      git: () => { throw original; },
    }),
    (error) => error === original,
  );
});

test("Git subprocesses fail closed within finite timeout and buffer bounds", () => {
  let observed;
  const output = runGit("C:/repo", ["ls-remote", "origin"], {
    spawn: (command, args, options) => {
      observed = { command, args, options };
      return { status: 0, stdout: "ok\n" };
    },
  });
  assert.equal(output, "ok\n");
  assert.equal(observed.command, "git");
  assert.deepEqual(observed.args, ["ls-remote", "origin"]);
  assert.equal(observed.options.timeout, 120_000);
  assert.equal(observed.options.killSignal, "SIGKILL");
  assert.equal(observed.options.maxBuffer, 64 * 1024 * 1024);
  assert.throws(
    () => runGit("C:/repo", ["status", "--porcelain"], {
      spawn: () => ({
        error: Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" }),
      }),
    }),
    /could not start git status: operation timed out/,
  );
  assert.throws(
    () => runGit("C:/repo", ["ls-tree", "-r", "HEAD"], {
      spawn: () => ({
        error: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" }),
      }),
    }),
    /could not start git ls-tree: stdout maxBuffer length exceeded/,
  );
});

test("explicit dry-run paths can bind selection to the current HEAD tree", () => {
  const calls = [];
  const trackedFiles = readHeadTrackedFiles({
    repoRoot: "C:/repo",
    git: (_repoRoot, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return `${B}\n`;
      return Buffer.from("CHANGELOG.md\0server/src/probe.test.ts\0");
    },
  });
  assert.deepEqual([...trackedFiles], ["CHANGELOG.md", "server/src/probe.test.ts"]);
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "HEAD"],
    ["ls-tree", "-r", "-z", "--name-only", B],
  ]);
});

test("planner CLI rejects an option-shaped required value before reading Git state", () => {
  const result = spawnSync(process.execPath, [runnerScript, "--repo-root", "--dry-run"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--repo-root requires a value/);
});

test("the changed-file dry-run CLI reads current HEAD tracking data", () => {
  const result = spawnSync(
    process.execPath,
    [
      runnerScript,
      "--dry-run",
      "--repo-root",
      repoRoot,
      "--changed-file",
      "scripts/run-pre-push-tests.test.mjs",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.selection.nodeTestFiles, ["scripts/run-pre-push-tests.test.mjs"]);
  assert.deepEqual(plan.selection.selectionErrors, []);
});

test("rejects unsafe remote identity and permits an update with no tree changes", () => {
  const updates = parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
  for (const remoteName of [undefined, null, {}, ""]) {
    assert.throws(
      () => resolveOutgoingChangedFiles({
        repoRoot: "C:/repo",
        remoteName,
        remoteLocation: "git@example.test:paperclip.git",
        updates,
      }),
      /unsafe or missing remote name/,
    );
  }
  assert.throws(
    () => resolveOutgoingChangedFiles({
      repoRoot: "C:/repo",
      remoteName: "../bad",
      remoteLocation: "git@example.test:paperclip.git",
      updates,
    }),
    PrePushIntegrityError,
  );
  assert.throws(
    () => resolveOutgoingChangedFiles({
      repoRoot: "C:/repo",
      remoteName: "--help",
      remoteLocation: "git@example.test:paperclip.git",
      updates,
    }),
    /unsafe or missing remote name/,
  );
  assert.deepEqual(
    resolveOutgoingChangedFiles({
      repoRoot: "C:/repo",
      remoteName: "origin",
      remoteLocation: "git@example.test:paperclip.git",
      updates,
      git: (_root, args) => {
        if (args[0] === "remote") return "git@example.test:paperclip.git\n";
        if (args[0] === "ls-remote") return `${A}\trefs/heads/dev\n`;
        return Buffer.alloc(0);
      },
    }),
    [],
  );
  assert.throws(
    () => resolveOutgoingChangedFiles({
      repoRoot: "C:/repo",
      remoteName: "origin",
      remoteLocation: "git@example.test:other.git",
      updates,
      git: (_root, args) => args[0] === "remote"
        ? "git@example.test:paperclip.git\n"
        : Buffer.alloc(0),
    }),
    /does not match a configured push URL/,
  );
});

test("content validation binds one clean update to the checked-out tracked HEAD", () => {
  const updates = parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
  const baseGit = (_repoRoot, args) => {
    if (args.includes("--verify")) return `${B}\n`;
    if (args.includes("--show-toplevel")) return "C:/repo\n";
    if (args[0] === "ls-files") {
      return Buffer.from("H server/src/a.ts\0H server/src/a.test.ts\0");
    }
    if (args[0] === "status") return Buffer.alloc(0);
    if (args[0] === "ls-tree") return Buffer.from("server/src/a.ts\0server/src/a.test.ts\0");
    throw new Error(`unexpected Git call: ${args.join(" ")}`);
  };
  const bound = assertPushMatchesWorkingTree({ repoRoot: "C:/repo", updates, git: baseGit });
  assert.equal(bound.headOid, B);
  assert.deepEqual([...bound.trackedFiles], ["server/src/a.ts", "server/src/a.test.ts"]);

  assert.throws(
    () => assertPushMatchesWorkingTree({
      repoRoot: "C:/repo",
      updates,
      git: (root, args) => args.includes("--verify") ? `${C}\n` : baseGit(root, args),
    }),
    /must be the current checked-out HEAD/,
  );
  assert.throws(
    () => assertPushMatchesWorkingTree({
      repoRoot: "C:/repo",
      updates,
      git: (root, args) => args[0] === "status" ? Buffer.from("?? untracked.test.ts\0") : baseGit(root, args),
    }),
    /worktree and index must be pristine/,
  );
  const second = parsePushUpdates(`refs/heads/other ${B} refs/heads/other ${A}\n`)[0];
  assert.throws(
    () => assertPushMatchesWorkingTree({ repoRoot: "C:/repo", updates: [...updates, second], git: baseGit }),
    /exactly one non-deletion ref update/,
  );
  assert.throws(
    () => assertPushMatchesWorkingTree({
      repoRoot: "C:/repo",
      updates,
      git: (root, args) => args[0] === "ls-files"
        ? Buffer.from("H server/src/a.ts\0S ui/src/hidden.test.ts\0")
        : baseGit(root, args),
    }),
    /hidden or non-normal index state: ui\/src\/hidden\.test\.ts/,
  );
});

test("deletion-only updates introduce no changed paths and need no working-tree binding", () => {
  const updates = parsePushUpdates(`(delete) ${ZERO} refs/heads/old ${A}\n`);
  assert.deepEqual(
    assertPushMatchesWorkingTree({ repoRoot: "C:/repo", updates, git: () => { throw new Error("unused"); } }),
    { headOid: null, trackedFiles: new Set() },
  );
  assert.deepEqual(resolveOutgoingChangedFiles({
    repoRoot: "C:/repo",
    remoteName: "origin",
    remoteLocation: "git@example.test:paperclip.git",
    updates,
    git: () => { throw new Error("unused"); },
  }), []);
});

function baseSelection(overrides = {}) {
  return {
    selectionErrors: [],
    hostedCiFiles: [],
    nodeTestFiles: [],
    vitestFiles: [],
    ...overrides,
  };
}

test("direct protected-branch pushes fail closed when hosted CI is required", () => {
  const errors = [];
  const status = executeTestPlan(
    {
      selection: baseSelection({ hostedCiFiles: [".github/workflows/pr.yml"] }),
      targetRefs: ["refs/heads/dev"],
    },
    { log: () => {}, error: (message) => errors.push(message) },
  );
  assert.equal(status, 2);
  assert.match(errors.join("\n"), /cannot be pushed directly to refs\/heads\/dev/);
});

test("an exact test child exit 19 is propagated and restored exit 0 passes", () => {
  const plan = {
    selection: baseSelection({ nodeTestFiles: ["scripts/probe.test.mjs"] }),
    targetRefs: ["refs/heads/topic"],
  };
  const failing = executeTestPlan(plan, {
    spawn: () => ({ status: 19 }),
    log: () => {},
    error: () => {},
  });
  assert.equal(failing, 19);

  const passing = executeTestPlan(plan, {
    spawn: () => ({ status: 0 }),
    log: () => {},
    error: () => {},
  });
  assert.equal(passing, 0);
});

test("Node suites run before exact Vitest suites with literal argv", () => {
  const calls = [];
  const status = executeTestPlan(
    {
      selection: baseSelection({
        nodeTestFiles: ["scripts/probe.test.mjs"],
        vitestFiles: ["server/src/probe.test.ts"],
      }),
      targetRefs: ["refs/heads/topic"],
    },
    {
      repoRoot: "C:/repo",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      log: () => {},
      error: () => {},
    },
  );

  assert.equal(status, 0);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["--test", "scripts/probe.test.mjs"],
    [path.join("C:/repo", "scripts/run-vitest-stable.mjs"), "--files", "server/src/probe.test.ts"],
  ]);
  assert.ok(calls.every(({ command }) => command === process.execPath));
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.every(({ options }) => options.windowsHide === true));
  assert.ok(calls.every(({ options }) => options.timeout === TEST_CHILD_TIMEOUT_MS));
  assert.ok(calls.every(({ options }) => options.maxBuffer === TEST_CHILD_MAX_BUFFER));
  assert.ok(calls.every(({ options }) => options.killSignal === "SIGKILL"));
  for (const { options } of calls) assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

for (const code of ["ENOENT", "ETIMEDOUT", "ENOBUFS"]) {
  test(`test child fails closed on ${code} and preserves both captured streams`, () => {
    const messages = [];
    const errors = [];
    const status = executeTestPlan({
      selection: baseSelection({ nodeTestFiles: ["scripts/probe.test.mjs"] }),
      targetRefs: ["refs/heads/topic"],
    }, {
      spawn: () => ({ status: null, stdout: "partial stdout", stderr: "partial stderr",
        error: Object.assign(new Error("synthetic child failure"), { code }) }),
      log: value => messages.push(value), error: value => errors.push(value),
    });
    assert.equal(status, 2);
    assert.ok(messages.includes("partial stdout"));
    assert.ok(errors.includes("partial stderr"));
    assert.match(errors.join("\n"), new RegExp(code));
  });
}

test("successful test child forwards stdout and stderr without changing its result", () => {
  const messages = []; const errors = [];
  const status = executeTestPlan({
    selection: baseSelection({ nodeTestFiles: ["scripts/probe.test.mjs"] }),
    targetRefs: ["refs/heads/topic"],
  }, {
    spawn: () => ({ status: 0, stdout: "passed output", stderr: "warning output" }),
    log: value => messages.push(value), error: value => errors.push(value),
  });
  assert.equal(status, 0);
  assert.ok(messages.includes("passed output"));
  assert.ok(errors.includes("warning output"));
});

test("workflow-only topic-branch plans run the local workflow lint and skip unit suites", () => {
  const calls = [];
  const logs = [];
  const status = executeTestPlan(
    {
      selection: baseSelection({
        changedFiles: [".github/workflows/docker.yml"],
        hostedCiFiles: [".github/workflows/docker.yml"],
      }),
      targetRefs: ["refs/heads/topic"],
    },
    {
      repoRoot: "C:/repo",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      log: (message) => logs.push(message),
      error: () => {},
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls.map(({ args }) => args), [
    [
      path.join("C:/repo", "scripts/lint-changed-workflows.mjs"),
      "--file",
      ".github/workflows/docker.yml",
    ],
  ]);
  assert.ok(calls.every(({ command }) => command === process.execPath));
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.match(logs.join("\n"), /No local unit suite was selected/);
});

test("a failed workflow lint rejects the topic-branch plan", () => {
  const status = executeTestPlan(
    {
      selection: baseSelection({
        hostedCiFiles: [".github/workflows/docker.yml"],
      }),
      targetRefs: ["refs/heads/topic"],
    },
    {
      repoRoot: "C:/repo",
      spawn: () => ({ status: 19 }),
      log: () => {},
      error: () => {},
    },
  );
  assert.equal(status, 19);
});

test("listChangedWorkflowFiles unions changed and hosted paths and ignores non-workflows", () => {
  assert.deepEqual(
    listChangedWorkflowFiles({
      changedFiles: [".github/workflows/docker.yml", "scripts/run-pre-push-tests.mjs"],
      hostedCiFiles: [".github/workflows/pr.yml", "pnpm-lock.yaml"],
    }),
    [".github/workflows/docker.yml", ".github/workflows/pr.yml"],
  );
  assert.deepEqual(listChangedWorkflowFiles(baseSelection()), []);
});
