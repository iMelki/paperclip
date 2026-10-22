import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEphemeralFile,
  ephemeralChildEnv,
  isEphemeralName,
  parseEphemeralName,
} from "../lib/ephemeral-scratch.mjs";

function withRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "eph-test-root-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a file created with an extension is recognized and parsed by the same grammar", () => {
  withRoot((root) => {
    const file = createEphemeralFile({ owner: "paperclip", purpose: "review", ext: "txt", root });
    const name = path.basename(file);
    assert.match(name, /-[a-z0-9]{6}\.txt$/);
    assert.equal(isEphemeralName(name), true);
    const parsed = parseEphemeralName(name);
    assert.equal(parsed.owner, "paperclip");
    assert.equal(parsed.purpose, "review");
    assert.ok(parsed.createdAt instanceof Date);
    assert.equal(isEphemeralName("eph-paperclip-review-20261021T000000Z-abc123.txt/../x"), false);
  });
});

test("a colliding random suffix is retried with a fresh name", () => {
  withRoot((root) => {
    const realRandom = Math.random;
    const values = [0.111111111, 0.111111111, 0.777777777, 0.777777777];
    let call = 0;
    Math.random = () => values[Math.min(call++, values.length - 1)];
    try {
      const date = new Date("2026-10-21T00:00:00Z");
      const first = createEphemeralFile({ owner: "paperclip", purpose: "review", root, date });
      const second = createEphemeralFile({ owner: "paperclip", purpose: "review", root, date });
      assert.notEqual(first, second);
      assert.equal(readdirSync(root).length, 2);
    } finally {
      Math.random = realRandom;
    }
  });
});

test("child temp roots that do not exist yet are created owner-private", { skip: process.platform === "win32" }, () => {
  withRoot((root) => {
    const dir = path.join(root, "a", "b");
    ephemeralChildEnv(dir);
    assert.equal(existsSync(dir), true);
    assert.equal(statSync(dir).mode & 0o077, 0);
  });
});
