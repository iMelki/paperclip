import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

test("entry-point comparison resolves junction and symlink aliases", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-main-module-"));
  try {
    const realDirectory = path.join(root, "real");
    const aliasDirectory = path.join(root, "alias");
    mkdirSync(realDirectory);
    const modulePath = path.join(realDirectory, "gate.mjs");
    const otherPath = path.join(realDirectory, "other.mjs");
    writeFileSync(modulePath, "export {};\n");
    writeFileSync(otherPath, "export {};\n");
    symlinkSync(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");

    assert.equal(
      isMainModule(pathToFileURL(modulePath), path.join(aliasDirectory, "gate.mjs")),
      true,
    );
    assert.equal(isMainModule(pathToFileURL(modulePath), otherPath), false);
    assert.equal(isMainModule(pathToFileURL(modulePath), ""), false);
    assert.equal(isMainModule(pathToFileURL(modulePath), null), false);
    assert.throws(
      () => isMainModule(pathToFileURL(modulePath), path.join(realDirectory, "missing.mjs")),
      /cannot resolve ESM entry point/,
    );
    const sentinel = Object.assign(new Error("sentinel realpath failure"), { code: "ESENTINEL" });
    assert.throws(
      () => isMainModule(pathToFileURL(modulePath), modulePath, () => { throw sentinel; }),
      (error) =>
        /cannot resolve ESM entry point.*ESENTINEL/.test(error.message) &&
        error.cause === sentinel,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
