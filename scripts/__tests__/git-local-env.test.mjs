import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  resolveGitLocalEnvironmentVariableNames,
  sanitizeGitLocalEnvironment,
} from "../git-local-env.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function runGit(args, { cwd, env }) {
  return spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("sanitizes Git repository-local variables without mutating the source environment", () => {
  const source = {
    GIT_DIR: "foreign.git",
    GIT_INDEX_FILE: ".git/index",
    GITHUB_ACTIONS: "true",
    PAPERCLIP_HOME: "/tmp/paperclip",
  };

  const sanitized = sanitizeGitLocalEnvironment(source, ["GIT_DIR", "GIT_INDEX_FILE"]);

  assert.deepEqual(sanitized, {
    GITHUB_ACTIONS: "true",
    PAPERCLIP_HOME: "/tmp/paperclip",
  });
  assert.equal(source.GIT_DIR, "foreign.git");
  assert.equal(source.GIT_INDEX_FILE, ".git/index");
});

test("enumerates GIT_INDEX_FILE as repository-local state", () => {
  const names = resolveGitLocalEnvironmentVariableNames({ cwd: repoRoot });
  assert.ok(names.includes("GIT_INDEX_FILE"));
});

test("sanitized test children can create a linked worktree from a foreign temporary repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-git-local-env-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const names = resolveGitLocalEnvironmentVariableNames({ cwd: repoRoot });
  const safeEnv = sanitizeGitLocalEnvironment(
    {
      ...process.env,
      GIT_DIR: path.join(repoRoot, ".git"),
      GIT_INDEX_FILE: ".git/index",
      GIT_WORK_TREE: repoRoot,
    },
    names,
  );

  try {
    let result = runGit(["init", repo], { cwd: root, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    result = runGit(["config", "user.email", "paperclip-test@example.com"], { cwd: repo, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    result = runGit(["config", "user.name", "Paperclip Test"], { cwd: repo, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(path.join(repo, "README.md"), "git local env regression\n", "utf8");
    result = runGit(["add", "README.md"], { cwd: repo, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    result = runGit(["commit", "-m", "initial"], { cwd: repo, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    result = runGit(["worktree", "add", "-b", "linked-test", worktree, "HEAD"], { cwd: repo, env: safeEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(worktree, ".git"), "utf8"), /^gitdir: /u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
