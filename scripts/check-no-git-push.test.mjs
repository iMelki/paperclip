import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  GIT_PUSH_PATTERN,
  SCAN_INTEGRITY_EXIT_CODE,
  ScanIntegrityError,
  collectScannableFiles,
  findGitPushOffenses,
  normalizeScanRoot,
  runCheck,
} from "./check-no-git-push.mjs";

/**
 * Real node:fs, except that one path fails with a chosen errno.
 *
 * The #76 fail-open bug was three swallowed filesystem errors. Reproducing them
 * with real permissions needs a platform-specific ACL/chmod fixture that does
 * not survive CI on both Windows and Linux, so the failure is injected here
 * instead -- the assertion is about what the check does with the error, and the
 * corresponding real-permission reproduction is recorded in .gate-evidence.json.
 */
function failingFs({ op, atPath, code }) {
  const fail = () => {
    const error = new Error(`injected ${code} for ${atPath}`);
    error.code = code;
    throw error;
  };
  const matches = (candidate) => path.resolve(candidate) === path.resolve(atPath);
  return {
    statSync: (target, ...rest) =>
      op === "statSync" && matches(target) ? fail() : statSync(target, ...rest),
    readdirSync: (target, ...rest) =>
      op === "readdirSync" && matches(target) ? fail() : readdirSync(target, ...rest),
    readFileSync: (target, ...rest) =>
      op === "readFileSync" && matches(target) ? fail() : readFileSync(target, ...rest),
  };
}

/**
 * A VIRTUAL symlink: real node:fs, except that `linkPath` behaves exactly as a
 * symlink-to-directory does -- `readdirSync` reports it with
 * `isDirectory() === false` / `isSymbolicLink() === true`, while a FOLLOWING
 * `statSync` resolves to the target directory, and every path beneath it maps
 * onto `targetPath`.
 *
 * This exists because #76 bypass B must be provable on every platform. Creating
 * a real symlink needs Developer Mode or elevation on Windows, so an on-disk
 * fixture would silently skip on exactly the machine where the bug was found.
 * The dirent semantics emulated here are Node's own and are what a Linux CI
 * checkout of the mode-120000 blob produces, so this is the portable half of the
 * proof; `#76 bypass B (on-disk)` below is the real-filesystem half.
 */
function virtualSymlinkFs({ linkPath, targetPath }) {
  const link = path.resolve(linkPath);
  const target = path.resolve(targetPath);
  const parent = path.dirname(link);
  const isUnder = (candidate) => {
    const resolved = path.resolve(candidate);
    if (resolved === link) return true;
    const relative = path.relative(link, resolved);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  // Any path at or beneath the link resolves onto the target tree.
  const redirect = (candidate) => {
    const resolved = path.resolve(candidate);
    if (resolved === link) return target;
    return path.join(target, path.relative(link, resolved));
  };
  const linkDirent = {
    name: path.basename(link),
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  };
  return {
    statSync: (candidate, ...rest) =>
      isUnder(candidate) ? statSync(redirect(candidate), ...rest) : statSync(candidate, ...rest),
    realpathSync: (candidate, ...rest) =>
      isUnder(candidate)
        ? realpathSync(redirect(candidate), ...rest)
        : realpathSync(candidate, ...rest),
    readFileSync: (candidate, ...rest) =>
      isUnder(candidate)
        ? readFileSync(redirect(candidate), ...rest)
        : readFileSync(candidate, ...rest),
    readdirSync: (candidate, ...rest) => {
      if (isUnder(candidate)) return readdirSync(redirect(candidate), ...rest);
      const entries = readdirSync(candidate, ...rest);
      if (path.resolve(candidate) !== parent) return entries;
      return [...entries, linkDirent];
    },
  };
}

/** True when this machine actually lets the test process create a symlink. */
function canCreateSymlinks() {
  const probe = mkdtempSync(path.join(os.tmpdir(), "no-git-push-symlink-probe-"));
  try {
    mkdirSync(path.join(probe, "target"));
    symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function withTempRepo(prefix, body) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(tmpRoot);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const OFFENDING_SOURCE =
  "import { execSync } from 'node:child_process';\nexecSync('git push origin main');\n";

test("regex matches common git push forms", () => {
  assert.ok(GIT_PUSH_PATTERN.test("git push"));
  assert.ok(GIT_PUSH_PATTERN.test("GIT PUSH"));
  assert.ok(GIT_PUSH_PATTERN.test("git  push origin master"));
  assert.ok(GIT_PUSH_PATTERN.test("git-push"));
  assert.ok(GIT_PUSH_PATTERN.test("git_push"));
});

test("regex ignores unrelated `push` usages", () => {
  assert.ok(!GIT_PUSH_PATTERN.test("args.push('git')"));
  assert.ok(!GIT_PUSH_PATTERN.test("notes.push('git remote')"));
  assert.ok(!GIT_PUSH_PATTERN.test("pushed"));
  assert.ok(!GIT_PUSH_PATTERN.test("git fetch"));
});

test("findGitPushOffenses flags a bare invocation in a string", () => {
  const text = `await exec("git push origin master");\n`;
  const offenses = findGitPushOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findGitPushOffenses ignores mentions inside `//` comments", () => {
  const text = `// sync-back alone — no \`git push\`, no fetch from any origin.\nconst x = 1;\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses allows opt-in marker on the same line", () => {
  const text = `await exec("git push origin master"); // ${ALLOW_MARKER}: operator-configured release mirror\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses allows opt-in marker on the line above", () => {
  const text = `// ${ALLOW_MARKER}: operator-configured release mirror\nawait exec("git push origin master");\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses flags string-literal push even when text is split across mixed quotes", () => {
  const text = "const cmd = `git push --tags`;\n";
  const offenses = findGitPushOffenses(text);
  assert.equal(offenses.length, 1);
});

test("findGitPushOffenses flags args-array form passed to spawn/execFile", () => {
  const cases = [
    `spawn("git", ["push", "origin", "main"]);\n`,
    `execFile('git', ['push', '--tags']);\n`,
    "execFile(`git`, [`push`, `--mirror`]);\n",
  ];
  for (const text of cases) {
    const offenses = findGitPushOffenses(text);
    assert.equal(offenses.length, 1, `expected match for ${text}`);
  }
});

test("findGitPushOffenses ignores `git push` in a comment after a string ending with a literal backslash", () => {
  // The closing `"` after `\\` should end the string (even literal count of
  // backslashes leaves the quote unescaped), so the `// git push` that
  // follows is comment text and must be stripped.
  const text = 'const path = "C:\\\\"; // git push origin master\nconst y = 2;\n';
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses does not flag args-array form when allow marker is present", () => {
  const text = `// ${ALLOW_MARKER}: release tooling adapter\nspawn("git", ["push", "origin", "main"]);\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("runCheck passes when scoped tree has no offenses", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-pass-"));
  try {
    mkdirSync(path.join(tmpRoot, "packages/adapters/sample/src"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters/sample/src/index.ts"),
      "export const ok = 1;\n",
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    // #76: the happy path must state a non-zero denominator, so a future
    // refactor that silently stops scanning goes red here instead of passing.
    assert.ok(
      logs.some((line) => /\b([1-9]\d*) file\(s\) scanned\b/.test(line)),
      `expected a non-zero scanned-file count in the pass line, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck fails when scoped tree contains an unapproved git push", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-fail-"));
  try {
    mkdirSync(path.join(tmpRoot, "packages/adapters/sample/src"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters/sample/src/index.ts"),
      "import { execSync } from 'node:child_process';\nexecSync('git push origin main');\n",
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("packages/adapters/sample/src/index.ts:2")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Scope test. It used to prove its point with a tree where NEITHER scan root
// existed, so it passed on a scan of zero files -- the same vacuous pass #76
// exploited. The intent (a `git push` in scripts/ is out of scope) is unchanged;
// the fixture now contains a real in-scope file so the run is non-vacuous.
test("runCheck does not scan files outside the configured roots", () => {
  withTempRepo("no-git-push-scope-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/release.mjs"),
      "execSync('git push origin v1.2.3');\n",
    );
    mkdirSync(path.join(tmpRoot, "packages/adapters/sample/src"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters/sample/src/index.ts"),
      "export const ok = 1;\n",
    );
    const code = runCheck({
      repoRoot: tmpRoot,
      // server/src is absent from this fixture, so it must be DECLARED optional.
      // A bare string now means "required" (fail-closed default, #76 bypass A).
      scanRoots: ["packages/adapters", { path: "server/src", optional: true }],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0);
  });
});

// --- #76 regression: filesystem errors must fail closed -------------------
//
// Each of the three tests below fails on the pre-fix script, which returned 0
// with "No unapproved `git push` invocations found" while an offending file sat
// unread on disk.

test("#76: renaming every scan root fails closed instead of passing on zero files", () => {
  withTempRepo("no-git-push-vacuous-", (tmpRoot) => {
    // The offending file is still on disk -- only its parent directory name
    // differs from the configured scan root.
    mkdirSync(path.join(tmpRoot, "packages/adapters-renamed/deep"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters-renamed/deep/evil.ts"),
      OFFENDING_SOURCE,
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", "packages/adapter-utils", "server/src", "cli/src"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.ok(
      errors.some((line) => line.includes("required scan roots ABSENT")),
      `expected an absent-required-root diagnostic, got: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((line) => line.includes("packages/adapters")),
      "expected the absent scan roots to be named",
    );
    assert.ok(
      !logs.some((line) => line.includes("No unapproved")),
      "must not print the reassuring pass line for a scan that read nothing",
    );
  });
});

// The vacuity guard is now reachable only when every root is DECLARED optional
// (required roots trip the stricter check above first). Keeping it under test
// matters: it is the last line of defence for a configuration that declares
// nothing mandatory, and an unreachable guard is an untested one.
test("#76: all-optional roots that are all absent still trip the zero-files vacuity guard", () => {
  withTempRepo("no-git-push-vacuous-optional-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters-renamed/deep"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters-renamed/deep/evil.ts"), OFFENDING_SOURCE);
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: [
        { path: "packages/adapters", optional: true },
        { path: "server/src", optional: true },
      ],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.ok(
      errors.some((line) => line.includes("scanned 0 files")),
      `expected a zero-files diagnostic, got: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      !logs.some((line) => line.includes("No unapproved")),
      "must not print the reassuring pass line for a scan that read nothing",
    );
  });
});

test("#76: an unreadable scan root fails closed and names the root and errno", () => {
  withTempRepo("no-git-push-statfail-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/src"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/src/evil.ts"), OFFENDING_SOURCE);
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
      fs: failingFs({
        op: "statSync",
        atPath: path.join(tmpRoot, "packages/adapters"),
        code: "EACCES",
      }),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    const joined = errors.join("\n");
    assert.match(joined, /cannot stat scan root packages\/adapters: EACCES/);
  });
});

test("#76: an unreadable directory mid-walk fails closed and names the directory", () => {
  withTempRepo("no-git-push-readdirfail-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/deep"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/deep/evil.ts"), OFFENDING_SOURCE);
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
      fs: failingFs({
        op: "readdirSync",
        atPath: path.join(tmpRoot, "packages/adapters/deep"),
        code: "EPERM",
      }),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    const joined = errors.join("\n");
    assert.match(joined, /cannot list directory packages\/adapters\/deep: EPERM/);
  });
});

test("#76: an unreadable file fails closed and names the file", () => {
  withTempRepo("no-git-push-readfilefail-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/evil.ts"), OFFENDING_SOURCE);
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
      fs: failingFs({
        op: "readFileSync",
        atPath: path.join(tmpRoot, "packages/adapters/evil.ts"),
        code: "EPERM",
      }),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    const joined = errors.join("\n");
    assert.match(joined, /cannot read packages\/adapters\/evil\.ts: EPERM/);
  });
});

test("#76: a scan root that exists but is a file fails closed", () => {
  withTempRepo("no-git-push-notdir-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters"), "not a directory\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /packages\/adapters exists but is not a directory/);
  });
});

// The counterpart to the fail-closed tests: a repo whose layout legitimately
// lacks an optional root still passes, and says which root it skipped. Without
// this, the fix would be indistinguishable from "hard-fail on any layout drift".
test("#76: an absent optional scan root is reported but does not fail the check", () => {
  withTempRepo("no-git-push-optional-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/src"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/src/index.ts"), "export const ok = 1;\n");
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", { path: "cli/src", optional: true }],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(
      logs.some((line) => line.includes("Optional scan roots absent") && line.includes("cli/src")),
      `expected the absent optional root to be named, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => line.includes("1 file(s) scanned")),
      "expected the pass line to state how many files were actually read",
    );
  });
});

// An offense still has to be reportable as an offense (exit 1), distinct from a
// scan-integrity failure (exit 2). Proving both directions keeps the fix from
// collapsing every outcome into "nonzero".
test("#76: a real offense still exits 1, not the scan-integrity code", () => {
  withTempRepo("no-git-push-still-1-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/src"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/src/evil.ts"), OFFENDING_SOURCE);
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 1);
    assert.notEqual(code, SCAN_INTEGRITY_EXIT_CODE);
  });
});

test("#76: collectScannableFiles throws ScanIntegrityError rather than returning []", () => {
  withTempRepo("no-git-push-collect-throw-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    assert.throws(
      () =>
        collectScannableFiles(path.join(tmpRoot, "packages/adapters"), tmpRoot, {
          fs: failingFs({
            op: "readdirSync",
            atPath: path.join(tmpRoot, "packages/adapters"),
            code: "EIO",
          }),
        }),
      (error) => error instanceof ScanIntegrityError && error.code === "EIO",
    );
  });
});

test("collectScannableFiles skips node_modules, dist, and .d.ts", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-collect-"));
  try {
    const adaptersRoot = path.join(tmpRoot, "packages/adapters/sample");
    mkdirSync(path.join(adaptersRoot, "src"), { recursive: true });
    mkdirSync(path.join(adaptersRoot, "dist"), { recursive: true });
    mkdirSync(path.join(adaptersRoot, "node_modules/pkg"), { recursive: true });
    writeFileSync(path.join(adaptersRoot, "src/index.ts"), "");
    writeFileSync(path.join(adaptersRoot, "src/types.d.ts"), "");
    writeFileSync(path.join(adaptersRoot, "dist/index.js"), "");
    writeFileSync(path.join(adaptersRoot, "node_modules/pkg/index.js"), "");

    const files = collectScannableFiles(
      path.join(tmpRoot, "packages/adapters"),
      tmpRoot,
    );
    const relatives = files.map((entry) => entry.relative).sort();
    assert.deepEqual(relatives, ["packages/adapters/sample/src/index.ts"]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- #76 REOPENED: the three bypasses that survived the first fix -----------
//
// Every test below was run against the pre-fix module before the fix landed and
// FAILED there. Evidence: .gate-evidence.json, key `reopened-2026-08-16`.

// ---- bypass B: a directory symlink swallowed an entire subtree -------------

test("#76 bypass B (portable): a symlinked directory inside a scan root is traversed, not dropped", () => {
  withTempRepo("no-git-push-symlink-virtual-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    // The offender lives outside the scan root; only the link makes it reachable.
    mkdirSync(path.join(tmpRoot, "hidden"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "hidden/evil.ts"), OFFENDING_SOURCE);

    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
      fs: virtualSymlinkFs({
        linkPath: path.join(tmpRoot, "packages/adapters/deep"),
        targetPath: path.join(tmpRoot, "hidden"),
      }),
    });
    // Pre-fix: 0, with "1 file(s) scanned across 1 of 1 scan root(s)".
    assert.equal(code, 1, "an offender behind a directory symlink must be found");
    assert.ok(
      errors.some((line) => line.includes("packages/adapters/deep/evil.ts")),
      `expected the offender to be named through the link, got: ${JSON.stringify(errors)}`,
    );
  });
});

test("#76 bypass B (portable): collectScannableFiles returns files behind a directory symlink", () => {
  withTempRepo("no-git-push-symlink-collect-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    mkdirSync(path.join(tmpRoot, "hidden"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "hidden/evil.ts"), OFFENDING_SOURCE);

    const files = collectScannableFiles(path.join(tmpRoot, "packages/adapters"), tmpRoot, {
      fs: virtualSymlinkFs({
        linkPath: path.join(tmpRoot, "packages/adapters/deep"),
        targetPath: path.join(tmpRoot, "hidden"),
      }),
    });
    const relatives = files.map((entry) => entry.relative).sort();
    // Pre-fix: ["packages/adapters/ok.ts"] only -- `deep` failed the extension
    // test on its extension-less name and the whole subtree disappeared.
    assert.deepEqual(relatives, [
      "packages/adapters/deep/evil.ts",
      "packages/adapters/ok.ts",
    ]);
  });
});

const SYMLINKS_SUPPORTED = canCreateSymlinks();
const symlinkSkip = SYMLINKS_SUPPORTED
  ? undefined
  : { skip: "this machine does not permit symlink creation" };

test("#76 bypass B (on-disk): a real directory symlink is traversed", symlinkSkip, () => {
  withTempRepo("no-git-push-symlink-real-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    mkdirSync(path.join(tmpRoot, "hidden"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "hidden/evil.ts"), OFFENDING_SOURCE);
    symlinkSync(path.join(tmpRoot, "hidden"), path.join(tmpRoot, "packages/adapters/deep"), "dir");

    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("deep/evil.ts")));
  });
});

// NOT a bypass fixture, and it does NOT fail against the pre-fix module: pre-fix
// never followed a directory symlink at all, so it could not loop. This guards
// the hazard the fix itself introduces -- once the walker follows links, a link
// pointing at its own ancestor is an infinite walk. Kept adjacent to the bypass-B
// tests because it is the cost of closing bypass B, not evidence for it.
test("#76 bypass B: a symlink cycle terminates instead of spinning", symlinkSkip, () => {
  withTempRepo("no-git-push-symlink-cycle-", (tmpRoot) => {
    const root = path.join(tmpRoot, "packages/adapters");
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;\n");
    // `loop` points back at its own ancestor: a naive walker never returns.
    symlinkSync(root, path.join(root, "nested/loop"), "dir");

    const logs = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    assert.equal(code, 0);
    // Counted once, not once per lap around the cycle.
    assert.ok(
      logs.some((line) => line.includes("1 file(s) scanned")),
      `expected the cycle to be visited once, got: ${JSON.stringify(logs)}`,
    );
  });
});

test("#76 bypass B: a dangling symlink fails closed and names the path", symlinkSkip, () => {
  withTempRepo("no-git-push-symlink-dangling-", (tmpRoot) => {
    const root = path.join(tmpRoot, "packages/adapters");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "ok.ts"), "export const ok = 1;\n");
    symlinkSync(path.join(tmpRoot, "does-not-exist"), path.join(root, "deep"), "dir");

    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /cannot resolve symlink packages\/adapters\/deep: ENOENT/);
  });
});

// ---- bypass A: renaming ONE scan root --------------------------------------

test("#76 bypass A: renaming ONE required scan root fails closed and names it", () => {
  withTempRepo("no-git-push-one-root-", (tmpRoot) => {
    // Three roots intact; the fourth -- the one holding the offender -- renamed.
    for (const dir of ["packages/adapters", "server/src", "cli/src"]) {
      mkdirSync(path.join(tmpRoot, dir), { recursive: true });
      writeFileSync(path.join(tmpRoot, dir, "ok.ts"), "export const ok = 1;\n");
    }
    mkdirSync(path.join(tmpRoot, "packages/adapter-utils-renamed"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapter-utils-renamed/evil.ts"),
      OFFENDING_SOURCE,
    );

    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", "packages/adapter-utils", "server/src", "cli/src"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    // Pre-fix: 0, with "3 file(s) scanned across 3 of 4 scan root(s)".
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.ok(
      errors.some((line) => line.includes("required scan roots ABSENT")),
      `expected an absent-required-root diagnostic, got: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((line) => line.includes("packages/adapter-utils")),
      "expected the renamed required root to be named",
    );
    assert.ok(
      !logs.some((line) => line.includes("No unapproved")),
      "must not print the reassuring pass line when a required root was not scanned",
    );
  });
});

test("#76 bypass A: a required root that exists but holds no scannable file fails closed", () => {
  withTempRepo("no-git-push-empty-root-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    // Present, so the absence check passes -- but emptied of scannable source.
    mkdirSync(path.join(tmpRoot, "cli/src"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "cli/src/README.md"), "# moved elsewhere\n");

    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", "cli/src"],
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /required scan roots with 0 scannable files:.*cli\/src/);
  });
});

// The control for both bypass-A tests: the DECLARATION is what decides. The same
// absent directory, declared optional, still passes -- so the fix is "absence
// must be declared", not "hard-fail on any layout drift".
test("#76 bypass A control: the same absent root declared optional still passes", () => {
  withTempRepo("no-git-push-one-root-control-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");

    const logs = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", { path: "packages/adapter-utils", optional: true }],
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.includes("Optional scan roots absent")));
  });
});

test("#76: scan-root declarations normalise fail-closed", () => {
  assert.deepEqual(normalizeScanRoot("server/src"), { path: "server/src", required: true });
  assert.deepEqual(normalizeScanRoot({ path: "cli/src" }), { path: "cli/src", required: true });
  assert.deepEqual(normalizeScanRoot({ path: "cli/src", optional: true }), {
    path: "cli/src",
    required: false,
  });
  assert.deepEqual(normalizeScanRoot({ path: "cli/src", required: false }), {
    path: "cli/src",
    required: false,
  });
  assert.throws(() => normalizeScanRoot({ path: "x", required: true, optional: true }), TypeError);
  assert.throws(() => normalizeScanRoot({}), TypeError);
  assert.throws(() => normalizeScanRoot(null), TypeError);
});

// ---- bypass C: unscanned extensions ----------------------------------------

for (const extension of [".mts", ".cts", ".jsx"]) {
  test(`#76 bypass C: an offender in a ${extension} file is scanned`, () => {
    withTempRepo(`no-git-push-ext-${extension.slice(1)}-`, (tmpRoot) => {
      mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
      writeFileSync(path.join(tmpRoot, `packages/adapters/evil${extension}`), OFFENDING_SOURCE);
      const errors = [];
      const code = runCheck({
        repoRoot: tmpRoot,
        scanRoots: ["packages/adapters"],
        log: () => {},
        error: (msg) => errors.push(msg),
      });
      assert.equal(code, 1, `${extension} must be scanned`);
      assert.ok(errors.some((line) => line.includes(`evil${extension}`)));
    });
  });
}

test("#76 bypass C: a .mts offender hidden beside scannable siblings still exits 1", () => {
  withTempRepo("no-git-push-ext-sibling-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    // Siblings pad the file count so the vacuity guard cannot mask the gap --
    // this is the exact shape that exited 0 pre-fix.
    writeFileSync(path.join(tmpRoot, "packages/adapters/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/b.tsx"), "export const b = 2;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/evil.mts"), OFFENDING_SOURCE);
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 1);
  });
});

test("#76 bypass C control: .d.mts and .d.cts declarations stay skipped", () => {
  withTempRepo("no-git-push-ext-dts-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/ok.ts"), "export const ok = 1;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/types.d.mts"), OFFENDING_SOURCE);
    writeFileSync(path.join(tmpRoot, "packages/adapters/types.d.cts"), OFFENDING_SOURCE);
    const files = collectScannableFiles(path.join(tmpRoot, "packages/adapters"), tmpRoot);
    assert.deepEqual(files.map((entry) => entry.relative), ["packages/adapters/ok.ts"]);
  });
});

// ---- reporting: the denominator must describe the TREE ----------------------

test("#76: the pass line reports tree coverage, not a count of scan roots", () => {
  withTempRepo("no-git-push-denominator-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/nested"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(tmpRoot, "packages/adapters/nested/b.ts"), "export const b = 2;\n");
    const logs = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    assert.equal(code, 0);
    const line = logs.find((entry) => entry.includes("No unapproved"));
    assert.ok(line, "expected a pass line");
    assert.match(line, /2 file\(s\) scanned across 2 director\(ies\)/);
    assert.match(line, /per root: packages\/adapters=2/);
    // The old root-count denominator is what made bypass B look healthy.
    assert.doesNotMatch(line, /of 1 scan root/);
  });
});
