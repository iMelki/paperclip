import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyBuildFile,
  copyBuildTree,
  executableMode,
  makeBuildFileExecutable,
  removeBuildPath,
  runBuildFilesystemCommand,
} from "../build-filesystem.mjs";

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "paperclip-build-filesystem-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("copyBuildFile creates its parent and preserves metacharacters in paths", (t) => {
  const root = createFixture(t);
  const source = "source files/input & ^ name.txt";
  const destination = "dist files/output & ^ name.txt";
  mkdirSync(path.join(root, path.dirname(source)), { recursive: true });
  writeFileSync(path.join(root, source), "copied");

  copyBuildFile(source, destination, { cwd: root });

  assert.equal(readFileSync(path.join(root, destination), "utf8"), "copied");
});

test("copyBuildTree copies into the exact destination without nesting the source directory", (t) => {
  const root = createFixture(t);
  mkdirSync(path.join(root, "src/assets/nested"), { recursive: true });
  mkdirSync(path.join(root, "dist/assets"), { recursive: true });
  writeFileSync(path.join(root, "src/assets/root.txt"), "root");
  writeFileSync(path.join(root, "src/assets/nested/child.txt"), "child");
  writeFileSync(path.join(root, "dist/assets/existing.txt"), "existing");

  copyBuildTree("src/assets", "dist/assets", { cwd: root });

  assert.equal(readFileSync(path.join(root, "dist/assets/root.txt"), "utf8"), "root");
  assert.equal(readFileSync(path.join(root, "dist/assets/nested/child.txt"), "utf8"), "child");
  assert.equal(readFileSync(path.join(root, "dist/assets/existing.txt"), "utf8"), "existing");
  assert.equal(existsSync(path.join(root, "dist/assets/assets")), false);
});

test("removeBuildPath removes a nested build output but refuses broad or escaping paths", (t) => {
  const root = createFixture(t);
  mkdirSync(path.join(root, "dist/nested"), { recursive: true });
  writeFileSync(path.join(root, "dist/nested/output.js"), "output");

  removeBuildPath("dist", { cwd: root });

  assert.equal(existsSync(path.join(root, "dist")), false);
  assert.throws(() => removeBuildPath(".", { cwd: root }), /stay below/);
  assert.throws(() => removeBuildPath("..", { cwd: root }), /stay below/);
  assert.throws(() => removeBuildPath(path.join("..", "outside"), { cwd: root }), /stay below/);
});

test("executable mode adds POSIX execute bits and is a Windows no-op", (t) => {
  assert.equal(executableMode(0o644, "linux"), 0o755);
  assert.equal(executableMode(0o100640, "darwin"), 0o751);
  assert.equal(executableMode(0o644, "win32"), null);

  const root = createFixture(t);
  writeFileSync(path.join(root, "dist.js"), "output");
  const target = path.join(root, "dist.js");
  if (process.platform === "win32") {
    const before = statSync(target).mode;
    makeBuildFileExecutable("dist.js", { cwd: root });
    assert.equal(statSync(target).mode, before);
  } else {
    chmodSync(target, 0o640);
    makeBuildFileExecutable("dist.js", { cwd: root });
    assert.equal(statSync(target).mode & 0o777, 0o751);
  }
});

test("command runner accepts multiple pairs and rejects incomplete commands", (t) => {
  const root = createFixture(t);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/one.txt"), "one");
  writeFileSync(path.join(root, "src/two.txt"), "two");

  runBuildFilesystemCommand(
    [
      "copy-file",
      "src/one.txt",
      "dist/one.txt",
      "src/two.txt",
      "dist/two.txt",
    ],
    { cwd: root },
  );

  assert.equal(readFileSync(path.join(root, "dist/one.txt"), "utf8"), "one");
  assert.equal(readFileSync(path.join(root, "dist/two.txt"), "utf8"), "two");
  assert.throws(
    () => runBuildFilesystemCommand(["copy-tree", "src"], { cwd: root }),
    /source\/destination/,
  );
  assert.throws(
    () => runBuildFilesystemCommand(["unknown"], { cwd: root }),
    /Usage/,
  );
});
