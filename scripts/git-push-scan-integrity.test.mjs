import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  ScanIntegrityError,
  assertNormalIndexState,
  containsTrackedPath,
  findUnobservedTrackedPaths,
  normalizeRepoPathKey,
  normalizeTrackedPathSet,
  parseTrackedManifest,
  readTrackedFiles,
  readTrackedManifest,
} from "./git-push-scan-integrity.mjs";

test("tracked-file enumeration fails closed and returns exact Git paths", () => {
  const output = Buffer.from("H packages/adapters/a.ts\0H server/src/b.ts\0");
  let spawnOptions;
  assert.deepEqual(
    [...readTrackedFiles("C:/repo", (_command, _args, options) => {
      spawnOptions = options;
      return { status: 0, stdout: output };
    })],
    ["packages/adapters/a.ts", "server/src/b.ts"],
  );
  assert.equal(spawnOptions.maxBuffer, 64 * 1024 * 1024);
  assert.equal(spawnOptions.timeout, 120_000);
  assert.equal(spawnOptions.killSignal, "SIGKILL");
  assert.throws(
    () => readTrackedFiles("C:/repo", () => ({ status: 9, stderr: "failed" })),
    /cannot enumerate tracked files/,
  );
  assert.throws(
    () => readTrackedFiles("C:/repo", () => ({
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    })),
    (error) => error instanceof ScanIntegrityError && error.code === "ENOENT",
  );
  assert.throws(
    () => readTrackedFiles("C:/repo", () => ({
      error: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" }),
    })),
    (error) =>
      error instanceof ScanIntegrityError &&
      error.code === "ENOBUFS" &&
      /maxBuffer/.test(error.message),
  );
  assert.throws(
    () => readTrackedFiles("C:/repo", () => ({
      error: Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" }),
    })),
    (error) =>
      error instanceof ScanIntegrityError &&
      error.code === "ETIMEDOUT" &&
      /timed out/.test(error.message),
  );
  assert.throws(
    () => parseTrackedManifest(Buffer.from("malformed-record-without-tag\0")),
    (error) => error instanceof ScanIntegrityError && error.code === "EGIT",
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
  assert.throws(
    () => assertNormalIndexState(null, ["packages/adapters"]),
    (error) => error instanceof ScanIntegrityError && error.code === "EINDEXUNKNOWN",
  );
});

test("tracked-directory matching follows host path case semantics", () => {
  const tracked = normalizeTrackedPathSet(new Set(["packages/adapters/Dist/index.js"]));
  assert.equal(
    containsTrackedPath("packages/adapters/dist", tracked),
    process.platform === "win32",
  );
  assert.equal(normalizeRepoPathKey("./server\\src/worker.ts"), "server/src/worker.ts");
});

test("manifest reconciliation names only missing tracked paths under scan roots", () => {
  assert.deepEqual(
    findUnobservedTrackedPaths({
      trackedFiles: normalizeTrackedPathSet(new Set([
        "packages/adapters/visible.ts",
        "packages/adapters/hidden.ts",
        "doc/out-of-scope.md",
      ])),
      scanRoots: ["packages/adapters"],
      observedPaths: new Set(["packages/adapters/visible.ts"]),
    }),
    ["packages/adapters/hidden.ts"],
  );
});
