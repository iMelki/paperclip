import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require("./check-forbidden-tokens-core.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const noUser = {
  userInfo: () => {
    throw new Error("no user");
  },
};

// ---------------------------------------------------------------------------
// Tokens are literals, not regexes.
//
// Tokens used to reach `git grep` as a BASIC REGEX, so the pattern searched was not
// the pattern written. Both directions were reproduced against this repo.
// ---------------------------------------------------------------------------

// Fail-CLOSED direction. A Windows path prefix ends in a backslash, which as a regex
// is `fatal: ... Trailing backslash` -> git exits 128 -> the fail-closed branch then
// blocks every commit in the repo until the token is removed.
test("a token ending in a backslash does not abort git", () => {
  const backslash = String.fromCharCode(92);
  const token = `C:${backslash}Users${backslash}`;

  const result = core.gitGrepToken({ token, repoRoot });

  assert.notEqual(result.status, 128, "trailing backslash must not abort the scan");
  assert.ok([0, 1].includes(result.status), `expected 0 or 1, got ${result.status}`);
});

// Fail-OPEN direction. An unescaped dot matches any character, so a `first.last`
// username silently scans for a different string than the one it was given.
test("a dot in a token does not match any character", () => {
  // The repo contains the hyphenated module name but never the dotted spelling. Both
  // spellings are assembled at run time so this file does not become a match for its
  // own probe -- a fixture that matches itself proves nothing in either direction.
  const stem = ["test", "shell"];

  const dotted = core.gitGrepToken({ token: stem.join("."), repoRoot });
  assert.equal(dotted.status, 1, "the dotted spelling must not match anything");
  assert.equal(dotted.stdout.trim(), "");

  // Control: the assertion above is only meaningful if this same call shape CAN report
  // a match. A scan that can never match anything proves nothing.
  const control = core.gitGrepToken({ token: stem.join("-"), repoRoot });
  assert.equal(control.status, 0, "control token must be found");
  assert.notEqual(control.stdout.trim(), "");
});

// ---------------------------------------------------------------------------
// Private token list resolution in a linked worktree.
//
// resolveRepoPaths() used `git rev-parse --git-dir`, which in a LINKED WORKTREE
// returns .git/worktrees/<name> -- a directory git never creates a hooks/ subdirectory
// in. The private list therefore resolved to a path that cannot exist,
// readForbiddenTokensFile() returned [] for the missing file, and every private
// pattern was silently skipped in every worktree while the check still printed a clean
// result. This builds a real repository and a real linked worktree.
// ---------------------------------------------------------------------------
test("the private token list is found from inside a linked worktree", (t) => {
  const forbiddenValue = "example-forbidden-name";
  const root = mkdtempSync(path.join(tmpdir(), "forbidden-tokens-worktree-"));
  const mainDir = path.join(root, "main");
  const worktreeDir = path.join(root, "worktree");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(mainDir);
  git(mainDir, "init", "-q", "-b", "main");
  git(mainDir, "config", "user.email", "proof@example.invalid");
  git(mainDir, "config", "user.name", "proof");
  writeFileSync(path.join(mainDir, "leaky.md"), `tracked content containing ${forbiddenValue}\n`);
  git(mainDir, "add", "-A");
  git(mainDir, "commit", "-q", "-m", "seed");
  git(mainDir, "worktree", "add", "-q", "-b", "feature", worktreeDir);

  // Deliver the private list exactly where the resolver documents it.
  const commonGitDir = git(mainDir, "rev-parse", "--git-common-dir").trim();
  const hooksDir = path.resolve(mainDir, commonGitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path.join(hooksDir, "forbidden-tokens.txt"), `# private\n${forbiddenValue}\n`);

  const checkFrom = (cwd) => {
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      const paths = core.resolveRepoPaths();
      const tokens = core.resolveForbiddenTokens(paths.tokensFiles, {}, noUser);
      const exitCode = core.runForbiddenTokenCheck({
        repoRoot: paths.repoRoot,
        tokens,
        log: () => {},
        error: () => {},
      });
      return { paths, tokens, exitCode };
    } finally {
      process.chdir(previous);
    }
  };

  const fromWorktree = checkFrom(worktreeDir);
  const fromMain = checkFrom(mainDir);

  // Both checkouts must land on the SAME private list -- that is the whole point.
  assert.equal(fromWorktree.paths.tokensFile, fromMain.paths.tokensFile);
  assert.ok(
    !fromWorktree.paths.tokensFile.includes("worktrees"),
    "must not resolve into .git/worktrees/<name>",
  );
  assert.ok(existsSync(fromWorktree.paths.tokensFile), "resolved private list must exist");

  // The leak must be blocked from inside the worktree.
  assert.ok(fromWorktree.tokens.includes(forbiddenValue));
  assert.equal(fromWorktree.exitCode, 1);

  // Control: the block must come from the value being present, not from the check
  // refusing everything. Remove it and the same worktree must pass.
  writeFileSync(path.join(worktreeDir, "leaky.md"), "nothing sensitive here\n");
  git(worktreeDir, "add", "-A");
  git(worktreeDir, "commit", "-q", "-m", "scrub");

  const scrubbed = checkFrom(worktreeDir);
  assert.ok(scrubbed.tokens.includes(forbiddenValue), "the token is still loaded");
  assert.equal(scrubbed.exitCode, 0, "a clean worktree must pass");
});

// ---------------------------------------------------------------------------
// Tracked list delivery.
//
// hooks/forbidden-tokens.txt exists in no checkout and nothing creates it, so the
// static-pattern path was dead: only the dynamically resolved username was ever
// scanned. The tracked list is the delivery path a clone actually carries.
// ---------------------------------------------------------------------------
test("the tracked list is read in addition to the private one", () => {
  const previous = process.cwd();
  try {
    process.chdir(repoRoot);
    const paths = core.resolveRepoPaths();

    assert.equal(paths.trackedTokensFile, path.resolve(repoRoot, "scripts/forbidden-tokens.txt"));
    assert.ok(existsSync(paths.trackedTokensFile), "the tracked list must ship in the repo");
    assert.deepEqual(paths.tokensFiles, [paths.trackedTokensFile, paths.tokensFile]);
  } finally {
    process.chdir(previous);
  }
});

// Proves the mechanism is live rather than merely present.
test("patterns are loaded from a tracked list file", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "forbidden-tokens-tracked-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const trackedFile = path.join(dir, "forbidden-tokens.txt");
  const missingPrivateFile = path.join(dir, "does-not-exist.txt");
  writeFileSync(trackedFile, "# header\nstructural-pattern\n\n# trailing comment\n");

  const tokens = core.resolveForbiddenTokens([trackedFile, missingPrivateFile], {}, noUser);

  // The absent private file contributes nothing and must not break the read.
  assert.deepEqual(tokens, ["structural-pattern"]);
});

// The list must not be a finding of itself, or adding any pattern would block every
// commit by matching the line that declares it.
test("the tracked list is excluded from its own scan", () => {
  // A phrase that appears in the tracked list and nowhere else in the tree, assembled
  // at run time so this test file is not itself a match for it.
  const selfOnly = ["DEFER", "one", "placeholder", "in"].join(" ").replace("DEFER ", "DEFER - ");

  const result = core.gitGrepToken({ token: selfOnly, repoRoot });
  assert.equal(result.status, 1, "the tracked list must be excluded from the scan");

  // Control: the same string IS present on disk, so a status of 1 above means
  // "excluded", not "the string was never there".
  const onDisk = readFileSync(path.resolve(repoRoot, "scripts/forbidden-tokens.txt"), "utf8");
  assert.ok(onDisk.includes(selfOnly), "control: the phrase is really in the tracked list");
});
