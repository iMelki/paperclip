import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  assertNormalIndexState,
  containsTrackedPath,
  findUnobservedTrackedPaths,
  normalizeRepoPathKey,
  parseTrackedManifest,
  readTrackedFiles,
  readTrackedManifest,
} from "./git-push-scan-integrity.mjs";

test("tracked-file enumeration fails closed and returns exact Git paths", () => {
  const output = Buffer.from("H packages/adapters/a.ts\0H server/src/b.ts\0");
  assert.deepEqual(
    [...readTrackedFiles("C:/repo", () => ({ status: 0, stdout: output }))],
    ["packages/adapters/a.ts", "server/src/b.ts"],
  );
  assert.throws(
    () => readTrackedFiles("C:/repo", () => ({ status: 9, stderr: "failed" })),
    /cannot enumerate tracked files/,
  );

  const hiddenOutput = Buffer.from(
    "H packages/adapters/normal.ts\0S packages/adapters/sparse.ts\0h packages/adapters/assumed.ts\0",
  );
  const manifest = readTrackedManifest("C:/repo", () => ({ status: 0, stdout: hiddenOutput }));
  assert.deepEqual([...manifest.nonStandardIndexPaths].sort(), [
    "packages/adapters/assumed.ts",
    "packages/adapters/sparse.ts",
  ]);
  assert.throws(
    () => assertNormalIndexState(manifest.nonStandardIndexPaths, ["packages/adapters"]),
    /hidden or non-normal index state: packages\/adapters\/assumed\.ts/,
  );
  assert.throws(
    () => assertNormalIndexState(parseTrackedManifest(hiddenOutput).nonStandardIndexPaths),
    /hidden or non-normal index state: packages\/adapters\/assumed\.ts/,
  );
});

test("tracked-directory matching follows host path case semantics", () => {
  const tracked = new Set(["packages/adapters/Dist/index.js"]);
  assert.equal(
    containsTrackedPath("packages/adapters/dist", tracked),
    process.platform === "win32",
  );
  assert.equal(normalizeRepoPathKey("./server\\src/worker.ts"), "server/src/worker.ts");
});

test("manifest reconciliation names only missing tracked paths under scan roots", () => {
  assert.deepEqual(
    findUnobservedTrackedPaths({
      trackedFiles: new Set([
        "packages/adapters/visible.ts",
        "packages/adapters/hidden.ts",
        "doc/out-of-scope.md",
      ]),
      scanRoots: ["packages/adapters"],
      observedPaths: new Set(["packages/adapters/visible.ts"]),
    }),
    ["packages/adapters/hidden.ts"],
  );
});
