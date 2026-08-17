import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrePushIntegrityError, parsePushUpdates } from "./run-pre-push-tests.mjs";
import {
  PrePushSecretScanError,
  buildPrePushSecretScans,
  executePrePushSecretScans,
} from "./scan-pre-push-secrets.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const ZERO = "0".repeat(40);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannerScript = path.join(repoRoot, "scripts", "scan-pre-push-secrets.mjs");

test("builds one exact scan per update and uses authoritative dev for a new branch", () => {
  const updates = parsePushUpdates([
    `refs/heads/topic ${B} refs/heads/topic ${A}`,
    `refs/heads/new ${C} refs/heads/new ${ZERO}`,
    `(delete) ${ZERO} refs/heads/old ${A}`,
  ].join("\n"));
  const calls = [];
  const git = (_repoRoot, args) => {
    calls.push(args);
    if (args[0] === "remote") return "git@example.test:paperclip.git\n";
    if (args[0] === "ls-remote") return `${D}\trefs/heads/dev\n`;
    if (args[0] === "merge-base") return "";
    throw new Error(`unexpected Git call: ${args.join(" ")}`);
  };
  assert.deepEqual(buildPrePushSecretScans({
    repoRoot: "C:/repo",
    remoteName: "origin",
    remoteLocation: "git@example.test:paperclip.git",
    updates,
    git,
  }), [
    {
      localRef: "refs/heads/topic",
      remoteRef: "refs/heads/topic",
      args: ["--range", `${A}..${B}`],
    },
    {
      localRef: "refs/heads/new",
      remoteRef: "refs/heads/new",
      args: ["--range", `${D}..${C}`],
    },
  ]);
  assert.ok(calls.some((args) => args[0] === "ls-remote"));
  assert.deepEqual(calls.at(-1), ["merge-base", "--is-ancestor", D, C]);
});

test("new-branch secret scans name divergence but preserve other Git failures", () => {
  const updates = parsePushUpdates(`refs/heads/new ${C} refs/heads/new ${ZERO}\n`);
  const build = (mergeError) => buildPrePushSecretScans({
    repoRoot: "C:/repo",
    remoteName: "origin",
    remoteLocation: "git@example.test:paperclip.git",
    updates,
    git: (_root, args) => {
      if (args[0] === "remote") return "git@example.test:paperclip.git\n";
      if (args[0] === "ls-remote") return `${A}\trefs/heads/dev\n`;
      if (args[0] === "merge-base") throw mergeError;
      throw new Error(`unexpected Git call: ${args.join(" ")}`);
    },
  });
  assert.throws(
    () => build(new PrePushIntegrityError("git merge-base failed with exit 1", { exitCode: 1 })),
    /pushed ref refs\/heads\/new must contain advertised refs\/heads\/dev object/,
  );
  const original = new PrePushIntegrityError("git merge-base failed with exit 128", { exitCode: 128 });
  assert.throws(() => build(original), (error) => error === original);
});

test("rejects an unsafe remote before constructing any scan", () => {
  const updates = parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
  for (const remoteName of [undefined, null, {}, ""]) {
    assert.throws(
      () => buildPrePushSecretScans({
        repoRoot: "C:/repo",
        remoteName,
        remoteLocation: "git@example.test:paperclip.git",
        updates,
      }),
      /unsafe or missing remote name/,
    );
  }
  assert.throws(
    () => buildPrePushSecretScans({
      repoRoot: "C:/repo",
      remoteName: "../origin",
      remoteLocation: "git@example.test:paperclip.git",
      updates,
    }),
    PrePushSecretScanError,
  );
  assert.throws(
    () => buildPrePushSecretScans({
      repoRoot: "C:/repo",
      remoteName: "-x",
      remoteLocation: "git@example.test:paperclip.git",
      updates,
    }),
    /unsafe or missing remote name/,
  );
  assert.throws(
    () => buildPrePushSecretScans({
      repoRoot: "C:/repo",
      remoteName: "origin",
      remoteLocation: "\0unsafe",
      updates,
    }),
    (error) =>
      error instanceof PrePushSecretScanError &&
      /unsafe or missing remote location/.test(error.message),
  );
});

test("rejects a push destination that does not match the configured remote", () => {
  const updates = parsePushUpdates(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
  assert.throws(
    () => buildPrePushSecretScans({
      repoRoot: "C:/repo",
      remoteName: "origin",
      remoteLocation: "git@example.test:other.git",
      updates,
      git: () => "git@example.test:paperclip.git\n",
    }),
    /does not match a configured push URL/,
  );
});

test("propagates the first verifier failure and restored children pass", () => {
  const scans = [
    { localRef: "refs/heads/a", remoteRef: "refs/heads/a", args: ["--range", `${A}..${B}`] },
    { localRef: "refs/heads/b", remoteRef: "refs/heads/b", args: ["--range", `${B}..${C}`] },
  ];
  let calls = 0;
  const failing = executePrePushSecretScans(scans, {
    spawn: () => ({ status: ++calls === 2 ? 23 : 0 }),
    log: () => {},
    error: () => {},
  });
  assert.equal(failing, 23);
  assert.equal(calls, 2);

  const passing = executePrePushSecretScans(scans, {
    spawn: () => ({ status: 0 }),
    log: () => {},
    error: () => {},
  });
  assert.equal(passing, 0);
});

test("verifier spawn errors and signals fail closed with attributable output", () => {
  const scans = [
    { localRef: "refs/heads/a", remoteRef: "refs/heads/a", args: ["--range", `${A}..${B}`] },
  ];
  const spawnErrors = [];
  assert.equal(executePrePushSecretScans(scans, {
    spawn: () => ({ error: new Error("sentinel spawn failure") }),
    log: () => {},
    error: (message) => spawnErrors.push(message),
  }), 2);
  assert.match(spawnErrors.join("\n"), /could not start: sentinel spawn failure/);

  const signalErrors = [];
  assert.equal(executePrePushSecretScans(scans, {
    spawn: () => ({ status: null, signal: "SIGTERM" }),
    log: () => {},
    error: (message) => signalErrors.push(message),
  }), 2);
  assert.match(signalErrors.join("\n"), /terminated by signal SIGTERM/);
});

test("secret scanner CLI rejects an option-shaped required value", () => {
  const result = spawnSync(
    process.execPath,
    [scannerScript, "--updates-file", "--repo-root"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, shell: false },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--updates-file requires a value/);
});
