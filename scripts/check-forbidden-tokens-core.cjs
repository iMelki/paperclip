const { execFileSync, execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const os = require("node:os");
const { resolve } = require("node:path");

/** Tracked, clone-delivered list of non-secret structural patterns. */
const TRACKED_TOKENS_FILE = "scripts/forbidden-tokens.txt";

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
      // -F IS LOAD-BEARING (fail-open/fail-closed fix, 2026-08-24)
      // Without it git grep reads the token as a BASIC REGEX, so the pattern that
      // gets searched is not the pattern that was written. Two proven directions:
      //   * fail-CLOSED denial of service: a token ending in a backslash -- the exact
      //     shape of a Windows path prefix like `C:\Users\` -- aborts git with
      //     `fatal: command line, 'C:\Users\': Trailing backslash` and exit 128. The
      //     fail-closed branch below then blocks every commit in the repo.
      //   * fail-OPEN mis-scan: a token containing `.` (a `first.last` username is the
      //     common case) has that `.` treated as "any character", so the check reports
      //     on something other than the secret it was told to guard.
      // A forbidden-token list is a list of literals, so search it as literals.
      // The tracked token list is excluded from its own scan: a pattern must not be
      // a finding of itself, or adding any structural pattern would instantly block
      // every commit by matching the line that declares it.
      [
        "grep",
        "-inF",
        "--no-color",
        "--",
        token,
        "--",
        ":!pnpm-lock.yaml",
        ":!.git",
        `:!${TRACKED_TOKENS_FILE}`,
      ],
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

/**
 * Merge every token source. `tokensFiles` accepts one path or several; missing
 * files contribute nothing, which is what lets the private per-machine list stay
 * optional. See resolveRepoPaths() for the two delivery paths and why there are two.
 */
function resolveForbiddenTokens(tokensFiles, env = process.env, osModule = os) {
  const files = Array.isArray(tokensFiles) ? tokensFiles : [tokensFiles];

  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...files.filter(Boolean).flatMap((file) => readForbiddenTokensFile(file)),
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

/**
 * Resolve the two forbidden-token delivery paths. There are deliberately two,
 * because the two kinds of token have opposite distribution requirements:
 *
 *  1. `<common .git>/hooks/forbidden-tokens.txt` -- PRIVATE, per machine, untracked.
 *     This is where a real operator name or host-specific string belongs: writing
 *     those into a tracked file would publish the very string the check exists to
 *     keep out of the repo. Nothing creates this file automatically; it is opt-in
 *     per clone, and absent means "no private patterns", not "check disabled".
 *  2. `scripts/forbidden-tokens.txt` -- TRACKED, delivered by `git clone`, for
 *     non-secret structural patterns that every checkout should share.
 *
 * --git-common-dir, NOT --git-dir (worktree fix, 2026-08-24)
 * In a LINKED WORKTREE `git rev-parse --git-dir` returns `.git/worktrees/<name>`,
 * and git never creates a `hooks/` subdirectory there. Path 1 therefore resolved to
 * a file that cannot exist, readForbiddenTokensFile() returned [] for the missing
 * file, and every private pattern was silently skipped in every linked worktree
 * while the check still printed a clean result. --git-common-dir returns the shared
 * `.git` from a main checkout and from every linked worktree alike.
 */
function resolveRepoPaths(exec = execSync) {
  const repoRoot = exec("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gitCommonDir = exec("git rev-parse --git-common-dir", {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
  const tokensFile = resolve(repoRoot, gitCommonDir, "hooks/forbidden-tokens.txt");
  const trackedTokensFile = resolve(repoRoot, TRACKED_TOKENS_FILE);

  return {
    repoRoot,
    tokensFile,
    trackedTokensFile,
    tokensFiles: [trackedTokensFile, tokensFile],
  };
}

function runCli() {
  const { repoRoot, tokensFiles } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFiles);
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
