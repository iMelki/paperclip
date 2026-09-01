import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  TestSelectionIntegrityError,
  classifyTestRunner,
  isTestBearingProductionFile,
  normalizeRepoPath,
  selectPrePushTests,
} from "./pre-push-test-selection.mjs";

function withFixture(run) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-pre-push-selector-"));
  const repoRoot = realpathSync(temporaryRoot);
  const trackedFiles = new Set();
  const write = (relativePath, contents = "") => {
    const absolutePath = path.join(repoRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
    trackedFiles.add(relativePath.replaceAll("\\", "/"));
  };
  try {
    return run({ repoRoot, trackedFiles, write });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("selects an exact changed Vitest suite without tracing its import graph", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("ui/src/lib/format.test.ts", "test('format', () => {});\n");
    write("ui/src/lib/unrelated.test.ts", "test('unrelated', () => {});\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["ui/src/lib/format.test.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.vitestFiles, ["ui/src/lib/format.test.ts"]);
    assert.deepEqual(result.nodeTestFiles, []);
    assert.deepEqual(result.selectionErrors, []);
  });
});

test("selects deterministic co-located and parent __tests__ siblings", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("server/src/services/heartbeat.ts", "export const heartbeat = true;\n");
    write("server/src/services/heartbeat.test.ts", "test('direct', () => {});\n");
    write("server/src/__tests__/heartbeat-recovery.test.ts", "test('recovery', () => {});\n");
    write("server/src/__tests__/unrelated.test.ts", "test('other', () => {});\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/services/heartbeat.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.vitestFiles, [
      "server/src/__tests__/heartbeat-recovery.test.ts",
      "server/src/services/heartbeat.test.ts",
    ]);
    assert.deepEqual(result.selectionErrors, []);
  });
});

test("selects exact declared contract tests without widening to an import graph", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("server/src/middleware/http-logger.ts", "export const logger = true;\n");
    write(
      "server/src/__tests__/http-log-redaction.test.ts",
      "test('redaction', () => {});\n",
    );
    write("server/src/__tests__/unrelated.test.ts", "test('other', () => {});\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/middleware/http-logger.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.vitestFiles, ["server/src/__tests__/http-log-redaction.test.ts"]);
    assert.deepEqual(result.coverage[0].siblingTests, []);
    assert.deepEqual(result.coverage[0].declaredTests, [
      "server/src/__tests__/http-log-redaction.test.ts",
    ]);
    assert.deepEqual(result.selectionErrors, []);
  });
});

test("fails closed when a declared contract test is absent", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("server/src/middleware/http-logger.ts", "export const logger = true;\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/middleware/http-logger.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.vitestFiles, []);
    assert.match(
      result.selectionErrors.join("\n"),
      /declared deterministic test is not a regular file/,
    );
  });
});

test("routes each test family to its real runner", () => {
  assert.equal(classifyTestRunner("scripts/check-no-git-push.test.mjs"), "node-test");
  assert.equal(classifyTestRunner("tests/e2e/onboarding.spec.ts"), "hosted-playwright");
  assert.equal(classifyTestRunner("packages/adapter-utils/src/execution.test.ts"), "vitest");
  assert.equal(
    classifyTestRunner("packages/plugins/plugin-workspace-diff/tests/contracts.spec.ts"),
    "hosted-unregistered",
  );
});

test("fails closed in its result when production code has no sibling test", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("packages/adapter-utils/src/uncovered.ts", "export const uncovered = true;\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["packages/adapter-utils/src/uncovered.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.vitestFiles, []);
    assert.deepEqual(result.uncoveredProductionFiles, ["packages/adapter-utils/src/uncovered.ts"]);
    assert.match(result.selectionErrors[0], /lacks a deterministic sibling or declared test/);
  });
});

test("a discovered sibling must be tracked in the pushed HEAD", () => {
  withFixture(({ repoRoot, write }) => {
    write("server/src/heartbeat.ts", "export const heartbeat = true;\n");
    write("server/src/heartbeat.test.ts", "test('heartbeat', () => {});\n");
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/heartbeat.ts"],
      trackedFiles: new Set(["server/src/heartbeat.ts"]),
    });
    assert.match(result.selectionErrors.join("\n"), /selected test is not tracked in the pushed HEAD/);
  });
});

test("removed tests require hosted CI instead of making topic-branch deletion impossible", () => {
  withFixture(({ repoRoot, trackedFiles }) => {
    const result = selectPrePushTests({
      repoRoot,
      changedFiles: ["ui/src/removed.test.ts"],
      trackedFiles,
    });
    assert.deepEqual(result.removedTestFiles, ["ui/src/removed.test.ts"]);
    assert.deepEqual(result.hostedCiFiles, ["ui/src/removed.test.ts"]);
    assert.deepEqual(result.selectionErrors, []);
  });
});

test("a removed production file runs a surviving sibling or requires hosted CI", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    write("server/src/removed-with-test.test.ts", "test('remaining contract', () => {});\n");
    const withSibling = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/removed-with-test.ts"],
      trackedFiles,
    });
    assert.deepEqual(withSibling.removedProductionFiles, ["server/src/removed-with-test.ts"]);
    assert.deepEqual(withSibling.vitestFiles, ["server/src/removed-with-test.test.ts"]);
    assert.deepEqual(withSibling.hostedCiFiles, []);
    assert.deepEqual(withSibling.selectionErrors, []);

    const withoutSibling = selectPrePushTests({
      repoRoot,
      changedFiles: ["server/src/removed-without-test.ts"],
      trackedFiles,
    });
    assert.deepEqual(withoutSibling.removedProductionFiles, ["server/src/removed-without-test.ts"]);
    assert.deepEqual(withoutSibling.hostedCiFiles, ["server/src/removed-without-test.ts"]);
    assert.deepEqual(withoutSibling.selectionErrors, []);
  });
});

test("workflow, hook, manifest, and config changes require hosted CI", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    const files = [
      ".github/workflows/pr.yml",
      ".husky/pre-push",
      "package.json",
      "vitest.config.ts",
    ];
    files.forEach((file) => write(file, "x\n"));
    const result = selectPrePushTests({ repoRoot, changedFiles: files, trackedFiles });
    assert.deepEqual(result.hostedCiFiles, [...files].sort());
  });
});

test("non-JavaScript runtime changes are explicitly assigned to hosted CI", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    const files = [
      "server/src/db/migration.sql",
      "packages/adapters/codex-local/src/server/bootstrap.sh",
      "scripts/check.ps1",
      ".github/scripts/check.py",
    ];
    files.forEach((file) => write(file, "runtime change\n"));
    const result = selectPrePushTests({ repoRoot, changedFiles: files, trackedFiles });
    assert.deepEqual(result.hostedCiFiles, [...files].sort());
    assert.deepEqual(result.selectionErrors, []);
  });
});

test("root enforcement and build configuration changes cannot fall through unclassified", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    const files = ["Dockerfile", ".gitleaks.toml", "tsconfig.json", ".github/dependabot.yml"];
    files.forEach((file) => write(file, "configuration\n"));
    const result = selectPrePushTests({ repoRoot, changedFiles: files, trackedFiles });
    assert.deepEqual(result.hostedCiFiles, [...files].sort());
    assert.deepEqual(result.nonProductionFiles, []);
  });
});

test("runtime Markdown and media assets require hosted CI", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    const files = ["ui/src/assets/logo.svg", "server/src/template.md"];
    files.forEach((file) => write(file, "runtime asset\n"));
    const result = selectPrePushTests({ repoRoot, changedFiles: files, trackedFiles });
    assert.deepEqual(result.hostedCiFiles, [...files].sort());
    assert.deepEqual(result.nonProductionFiles, []);
  });
});

test("documentation is explicitly classified as non-production", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    const files = [
      "CHANGELOG.md",
      "doc/DEVELOPING.md",
      "docs/guides/example.svg",
      "packages/adapters/README.md",
    ];
    files.forEach((file) => write(file, "documentation\n"));
    const result = selectPrePushTests({ repoRoot, changedFiles: files, trackedFiles });
    assert.deepEqual(result.hostedCiFiles, []);
    assert.deepEqual(result.nonProductionFiles, [...files].sort());
  });
});

test("rejects empty, absolute, parent-relative, and symlink inputs", () => {
  withFixture(({ repoRoot, trackedFiles, write }) => {
    assert.throws(
      () => selectPrePushTests({ repoRoot, changedFiles: [], trackedFiles }),
      /no resolvable changed paths/,
    );
    for (const badPath of ["../outside.ts", "C:/outside.ts", "/outside.ts", " scripts/clean.mjs"]) {
      assert.throws(() => normalizeRepoPath(badPath), TestSelectionIntegrityError);
    }

    write("real-tests/link.test.ts", "test('real', () => {});\n");
    mkdirSync(path.join(repoRoot, "ui"), { recursive: true });
    const link = path.join(repoRoot, "ui/src");
    symlinkSync(
      path.join(repoRoot, "real-tests"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => selectPrePushTests({ repoRoot, changedFiles: ["ui/src/link.test.ts"], trackedFiles }),
      /symbolic-link traversal is not valid/,
    );
  });
});

test("rejects missing pushed-HEAD tracking data and non-array changed paths", () => {
  withFixture(({ repoRoot, write }) => {
    write("ui/src/lib/format.test.ts", "test('format', () => {});\n");
    assert.throws(
      () => selectPrePushTests({ repoRoot, changedFiles: ["ui/src/lib/format.test.ts"] }),
      /tracked files from the pushed HEAD are required/,
    );
    for (const changedFiles of [null, {}, "ui/src/lib/format.test.ts", new Set()]) {
      assert.throws(
        () => selectPrePushTests({ repoRoot, changedFiles, trackedFiles: new Set() }),
        (error) =>
          error instanceof TestSelectionIntegrityError &&
          error.message === "changed files must be supplied as an array",
      );
    }
  });
});

test("does not treat generated declarations or docs as test-bearing production", () => {
  assert.equal(isTestBearingProductionFile("packages/shared/src/generated/schema.ts"), false);
  assert.equal(isTestBearingProductionFile("packages/shared/src/types.d.ts"), false);
  assert.equal(isTestBearingProductionFile("doc/DEVELOPING.md"), false);
  assert.equal(isTestBearingProductionFile("scripts/check-no-git-push.mjs"), true);
});
