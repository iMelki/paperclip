import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
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
      scanRoots: ["packages/adapters", "server/src"],
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
      errors.some((line) => line.includes("scanned 0 files")),
      `expected a zero-files diagnostic, got: ${JSON.stringify(errors)}`,
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
      scanRoots: ["packages/adapters", "cli/src"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(
      logs.some((line) => line.includes("Scan roots absent") && line.includes("cli/src")),
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
