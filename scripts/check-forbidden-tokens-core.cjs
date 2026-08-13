const { execFileSync, execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const os = require("node:os");
const { resolve } = require("node:path");

/**
 * Run `git grep` for one token, returning git's exit status instead of throwing.
 *
 * WHY argv AND NOT A SHELL STRING (this is a fail-open bug fix, 2026-08-13)
 * The previous implementation built one shell string and ran it through
 * `execSync`, which on Windows routes via cmd.exe. cmd.exe does not strip single
 * quotes, so the pathspecs `':!pnpm-lock.yaml' ':!.git'` reached git with their
 * quotes attached and git aborted with exit 128:
 *
 *     fatal: ':!pnpm-lock.yaml': '':!pnpm-lock.yaml'' is outside repository
 *
 * `execSync` throws on any non-zero exit, and the caller's catch-all treated that
 * 128 exactly like the exit 1 that means "no matches". The result: on every
 * Windows host in this fleet -- which is all of them -- this check reported
 * "No forbidden tokens found" unconditionally and could never fail. It ran in
 * both the pre-commit and pre-push gates while being incapable of blocking
 * anything.
 *
 * Passing argv removes the shell from the path entirely, so no quoting applies.
 */
function gitGrepToken({ token, repoRoot, exec = execFileSync }) {
  try {
    const stdout = exec(
      "git",
      ["grep", "-in", "--no-color", "--", token, "--", ":!pnpm-lock.yaml", ":!.git"],
      {
        encoding: "utf8",
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        // A widely-present token can match thousands of lines. Node's default
        // 1 MB stdout buffer overflows with ENOBUFS and no exit status, which the
        // old catch-all also read as "clean" -- the same fail-open shape as the
        // quoting bug, from a different cause. Found by the fail-closed path
        // above on the first real negative test, so keep the headroom generous.
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { status: 0, stdout: stdout ?? "" };
  } catch (err) {
    // git grep exits 1 for "no matches" -- the only non-zero we may ignore.
    // Anything else (128 bad pathspec, ENOENT, killed) is an error we must not
    // silently read as "clean"; the caller fails closed on a null/other status.
    const status = typeof err?.status === "number" ? err.status : null;
    return { status, stdout: typeof err?.stdout === "string" ? err.stdout : "", error: err };
  }
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  grep = gitGrepToken,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  let found = false;
  let broken = false;

  for (const token of tokens) {
    const { status, stdout } = grep({ token, repoRoot });

    // Fail closed. A scan that did not run is not a scan that found nothing --
    // conflating the two is what made this check unable to fail for the whole
    // time it was installed in two hooks.
    if (status !== 0 && status !== 1) {
      broken = true;
      error(
        `ERROR: forbidden-token scan did not run (git exited ${status === null ? "abnormally" : status}).`,
      );
      continue;
    }

    if (status === 0 && stdout.trim()) {
      if (!found) {
        error("ERROR: Forbidden tokens found in tracked files:\n");
      }
      found = true;
      for (const line of stdout.trim().split("\n")) {
        error(`  ${line}`);
      }
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  if (broken) {
    error("\nBuild blocked: the scan could not complete, so the tree is unverified.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

function resolveRepoPaths(exec = execSync) {
  const repoRoot = exec("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gitDir = exec("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt"),
  };
}

function runCli() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  process.exit(runForbiddenTokenCheck({ repoRoot, tokens }));
}

module.exports = {
  gitGrepToken,
  readForbiddenTokensFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  resolveRepoPaths,
  runCli,
  runForbiddenTokenCheck,
};
