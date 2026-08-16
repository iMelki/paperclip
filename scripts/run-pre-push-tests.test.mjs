import assert from "node:assert/strict";
import test from "node:test";

import {
  PrePushIntegrityError,
  assertPushMatchesWorkingTree,
  executeTestPlan,
  parsePushUpdates,
  resolveOutgoingChangedFiles,
} from "./run-pre-push-tests.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ZERO = "0".repeat(40);

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

test("uses the exact remote-to-local range for an existing remote ref", () => {
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "remote") return "git@example.test:paperclip.git\n";
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
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", A, B, "--"],
  ]);
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
    "diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", A, C, "--",
  ]);
});

test("rejects unsafe remote identity and permits an update with no tree changes", () => {
  const updates = parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
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
      git: (_root, args) => args[0] === "remote"
        ? "git@example.test:paperclip.git\n"
        : Buffer.alloc(0),
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
