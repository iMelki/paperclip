import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCAN_INTEGRITY_EXIT_CODE,
  ScanIntegrityError,
  collectScannableFiles,
  runCheck,
} from "./check-no-git-push.mjs";
import { normalizeTrackedPathSet } from "./git-push-scan-integrity.mjs";

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
    lstatSync: (target, ...rest) =>
      op === "lstatSync" && matches(target) ? fail() : lstatSync(target, ...rest),
    statSync: (target, ...rest) =>
      op === "statSync" && matches(target) ? fail() : statSync(target, ...rest),
    readdirSync: (target, ...rest) =>
      op === "readdirSync" && matches(target) ? fail() : readdirSync(target, ...rest),
    readFileSync: (target, ...rest) =>
      op === "readFileSync" && matches(target) ? fail() : readFileSync(target, ...rest),
    realpathSync: (target, ...rest) => realpathSync(target, ...rest),
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
      scanRoots: ["packages/adapters"],
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

test("#76: one missing required scan root fails even while other roots are readable", () => {
  withTempRepo("no-git-push-vacuous-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters-renamed/deep"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters-renamed/deep/evil.ts"),
      OFFENDING_SOURCE,
    );
    for (const root of ["packages/adapter-utils", "server/src", "cli/src"]) {
      mkdirSync(path.join(tmpRoot, root), { recursive: true });
      writeFileSync(path.join(tmpRoot, root, "clean.ts"), "export const clean = true;\n");
    }
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
      errors.some((line) => line.includes("missing required roots")),
      `expected a required-root diagnostic, got: ${JSON.stringify(errors)}`,
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
        op: "lstatSync",
        atPath: path.join(tmpRoot, "packages/adapters"),
        code: "EACCES",
      }),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    const joined = errors.join("\n");
    assert.match(joined, /cannot stat scan root packages\/adapters: EACCES/);
  });
});

test("#76: a stat failure after lstat fails closed and names the root", () => {
  withTempRepo("no-git-push-stat-second-fail-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/clean.ts"), "export {};\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
      fs: failingFs({
        op: "statSync",
        atPath: path.join(tmpRoot, "packages/adapters"),
        code: "EIO",
      }),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /cannot stat scan root packages\/adapters: EIO/);
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
    assert.match(joined, /cannot read or decode packages\/adapters\/evil\.ts as UTF-8: EPERM/);
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
      scanRoots: ["packages/adapters", { path: "cli/src", required: false }],
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

test("#76: a directory symlink inside a scan root is an integrity failure", () => {
  for (const linkName of ["deep", "dist"]) {
    withTempRepo("no-git-push-symlink-", (tmpRoot) => {
      const target = path.join(tmpRoot, "hidden-adapter");
      const link = path.join(tmpRoot, "packages/adapters", linkName);
      mkdirSync(target, { recursive: true });
      mkdirSync(path.dirname(link), { recursive: true });
      writeFileSync(path.join(target, "evil.ts"), OFFENDING_SOURCE);
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

      const errors = [];
      const code = runCheck({
        repoRoot: tmpRoot,
        scanRoots: ["packages/adapters"],
        log: () => {},
        error: (message) => errors.push(message),
      });

      assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
      assert.match(
        errors.join("\n"),
        new RegExp(`symbolic link inside scan root is not allowed: packages/adapters/${linkName}`),
      );
    });
  }
});

test("#76: a symbolic-link scan root itself is an integrity failure", () => {
  withTempRepo("no-git-push-root-symlink-", (tmpRoot) => {
    const realRoot = path.join(tmpRoot, "real-adapters");
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(path.join(realRoot, "clean.ts"), "export {};\n");
    mkdirSync(path.join(tmpRoot, "packages"), { recursive: true });
    symlinkSync(realRoot, path.join(tmpRoot, "packages/adapters"), process.platform === "win32" ? "junction" : "dir");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /scan root packages\/adapters is a symbolic link/);
  });
});

test("#76: realpath failures and unsupported entry kinds fail closed", () => {
  withTempRepo("no-git-push-realpath-fail-", (tmpRoot) => {
    const scanRoot = path.join(tmpRoot, "packages/adapters");
    mkdirSync(scanRoot, { recursive: true });
    writeFileSync(path.join(scanRoot, "clean.ts"), "export {};\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
      fs: {
        ...failingFs({ op: "none", atPath: scanRoot, code: "EIO" }),
        realpathSync: (target) => {
          if (path.resolve(target) === path.resolve(scanRoot)) {
            const failure = new Error("injected realpath failure");
            failure.code = "EIO";
            throw failure;
          }
          return realpathSync(target);
        },
      },
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /cannot resolve packages\/adapters: EIO/);
  });

  withTempRepo("no-git-push-entry-kind-", (tmpRoot) => {
    const scanRoot = path.join(tmpRoot, "packages/adapters");
    mkdirSync(scanRoot, { recursive: true });
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
      fs: {
        lstatSync,
        statSync,
        readFileSync,
        realpathSync,
        readdirSync: () => [{
          name: "socket-entry",
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => false,
        }],
      },
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /unsupported filesystem entry/);
  });
});

test("#76: declared JavaScript and runtime-script extensions are all scanned", () => {
  for (const extension of [".mts", ".cts", ".jsx", ".sh", ".ps1", ".py"]) {
    withTempRepo(`no-git-push-${extension.slice(1)}-`, (tmpRoot) => {
      mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
      writeFileSync(path.join(tmpRoot, `packages/adapters/evil${extension}`), OFFENDING_SOURCE);
      const errors = [];
      const code = runCheck({
        repoRoot: tmpRoot,
        scanRoots: ["packages/adapters"],
        log: () => {},
        error: (message) => errors.push(message),
      });
      assert.equal(code, 1, `expected ${extension} offender to be rejected`);
      assert.ok(errors.join("\n").includes(`evil${extension}:2`));
    });
  }
});

test("#76: each present required root must contain a scannable file", () => {
  withTempRepo("no-git-push-empty-required-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    mkdirSync(path.join(tmpRoot, "server/src"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "server/src/clean.ts"), "export const clean = true;\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters", "server/src"],
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /required scan root packages\/adapters contains zero scannable files/);
  });
});

test("#76: an ancestor junction cannot move a declared root outside the repository", () => {
  const container = mkdtempSync(path.join(os.tmpdir(), "no-git-push-ancestor-junction-"));
  try {
    const repoRoot = path.join(container, "repo");
    const outsidePackages = path.join(container, "outside-packages");
    mkdirSync(path.join(repoRoot), { recursive: true });
    mkdirSync(path.join(outsidePackages, "adapters"), { recursive: true });
    writeFileSync(path.join(outsidePackages, "adapters/evil.ts"), OFFENDING_SOURCE);
    symlinkSync(outsidePackages, path.join(repoRoot, "packages"), process.platform === "win32" ? "junction" : "dir");
    const errors = [];
    const code = runCheck({
      repoRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /junction or symbolic-link traversal is not allowed/);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("#76: unsupported source encoding is an integrity error, not a scanned pass", () => {
  withTempRepo("no-git-push-utf16-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapters/evil.ts"),
      Buffer.from("exec('git push origin main');\n", "utf16le"),
    );
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(errors.join("\n"), /cannot read or decode .* as UTF-8/);
  });
});

test("#76: invoking the scanner through a directory junction still runs the gate", () => {
  withTempRepo("no-git-push-main-junction-", (tmpRoot) => {
    const alias = path.join(tmpRoot, "scripts-alias");
    symlinkSync(
      path.dirname(fileURLToPath(import.meta.url)),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const script = path.join(alias, "check-no-git-push.mjs");
    const init = spawnSync("git", ["init", "--quiet"], {
      cwd: tmpRoot,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    assert.equal(init.status, 0, init.stderr);
    const result = spawnSync(process.execPath, [script], {
      cwd: tmpRoot,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    assert.equal(result.status, SCAN_INTEGRITY_EXIT_CODE, result.stderr);
    assert.match(result.stderr, /missing required roots/);
  });
});

test("#76: the pass denominator reports tree coverage, not only root count", () => {
  withTempRepo("no-git-push-coverage-", (tmpRoot) => {
    mkdirSync(path.join(tmpRoot, "packages/adapters/nested"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "packages/adapters/nested/clean.ts"), "export const ok = 1;\n");
    const logs = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      log: (message) => logs.push(message),
      error: () => {},
    });
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /2 directories walked; 2 filesystem entries inspected/);
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

test("collectScannableFiles excludes docs and only untracked declared generated directories", () => {
  withTempRepo("no-git-push-collect-", (tmpRoot) => {
    const adaptersRoot = path.join(tmpRoot, "packages/adapters/sample");
    mkdirSync(path.join(adaptersRoot, "src"), { recursive: true });
    writeFileSync(path.join(adaptersRoot, "src/index.ts"), "");
    writeFileSync(path.join(adaptersRoot, "src/types.d.ts"), "");
    writeFileSync(path.join(adaptersRoot, "README.md"), "documentation\n");

    const files = collectScannableFiles(
      path.join(tmpRoot, "packages/adapters"),
      tmpRoot,
    );
    const relatives = files.map((entry) => entry.relative).sort();
    assert.deepEqual(relatives, ["packages/adapters/sample/src/index.ts"]);

    mkdirSync(path.join(adaptersRoot, "dist"), { recursive: true });
    writeFileSync(path.join(adaptersRoot, "dist/index.js"), "");
    assert.throws(
      () => collectScannableFiles(path.join(tmpRoot, "packages/adapters"), tmpRoot),
      /tracked generated\/cache directory inside scan root requires explicit review/,
    );
    const untrackedFiles = collectScannableFiles(
      path.join(tmpRoot, "packages/adapters"),
      tmpRoot,
      { trackedFiles: new Set(["packages/adapters/sample/src/index.ts"]) },
    );
    assert.deepEqual(untrackedFiles.map((entry) => entry.relative), [
      "packages/adapters/sample/src/index.ts",
    ]);
  });
});

test("runCheck rejects a tracked manifest without its index state", () => {
  const errors = [];
  const code = runCheck({
    repoRoot: ".",
    scanRoots: ["packages/adapters"],
    trackedFiles: new Set(["packages/adapters/example.ts"]),
    log: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
  assert.match(errors.join("\n"), /tracked files and index state must be supplied together/);
});

test("#76: undeclared extensions and extensionless scripts fail closed", () => {
  for (const file of ["adapter.wat", "runner"]) {
    withTempRepo("no-git-push-unknown-type-", (tmpRoot) => {
      mkdirSync(path.join(tmpRoot, "packages/adapters"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "packages/adapters", file), "git push origin main\n");
      const errors = [];
      const code = runCheck({
        repoRoot: tmpRoot,
        scanRoots: ["packages/adapters"],
        log: () => {},
        error: (message) => errors.push(message),
      });
      assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
      assert.match(errors.join("\n"), /undeclared file type inside scan root/);
    });
  }
});

test("tracked paths under scan roots must be physically observed or classified", () => {
  withTempRepo("no-git-push-tracked-manifest-", (tmpRoot) => {
    const scanRoot = path.join(tmpRoot, "packages/adapters");
    mkdirSync(scanRoot, { recursive: true });
    writeFileSync(path.join(scanRoot, "visible.ts"), "export const visible = true;\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      trackedFiles: new Set([
        "packages/adapters/visible.ts",
        "packages/adapters/hidden.ts",
      ]),
      nonStandardIndexPaths: new Set(),
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(
      errors.join("\n"),
      /tracked path under scan roots was not observed in the working tree: packages\/adapters\/hidden\.ts/,
    );
  });
});

test("hidden index flags reject even when the tracked path is physically visible", () => {
  withTempRepo("no-git-push-hidden-index-", (tmpRoot) => {
    const scanRoot = path.join(tmpRoot, "packages/adapters");
    mkdirSync(scanRoot, { recursive: true });
    writeFileSync(path.join(scanRoot, "hidden.ts"), "export const clean = true;\n");
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapters"],
      trackedFiles: new Set(["packages/adapters/hidden.ts"]),
      nonStandardIndexPaths: new Set(["packages/adapters/hidden.ts"]),
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, SCAN_INTEGRITY_EXIT_CODE);
    assert.match(
      errors.join("\n"),
      /tracked path under scan roots has a hidden or non-normal index state: packages\/adapters\/hidden\.ts/,
    );
  });
});

test("Windows tracked generated-directory matching is case-insensitive", {
  skip: process.platform !== "win32",
}, () => {
  withTempRepo("no-git-push-generated-case-", (tmpRoot) => {
    const scanRoot = path.join(tmpRoot, "packages/adapters");
    mkdirSync(path.join(scanRoot, "dist"), { recursive: true });
    writeFileSync(path.join(scanRoot, "dist/index.js"), "export {};\n");
    assert.throws(
      () => collectScannableFiles(scanRoot, tmpRoot, {
        trackedFiles: normalizeTrackedPathSet(new Set(["packages/adapters/Dist/index.js"])),
      }),
      /tracked generated\/cache directory inside scan root requires explicit review/,
    );
  });
});
