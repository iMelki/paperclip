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
function gitGrepToken({ token, repoRoot, exec = execFileSync, textOutput = false }) {
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
        ...(textOutput ? ["--text", "-h", "--no-column", "--no-heading", "--no-break"] : []),
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
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 15000,
        killSignal: "SIGKILL",
        // A widely-present token can match thousands of lines. Node's default
        // 1 MB stdout buffer overflows with ENOBUFS and no exit status, which the
        // old catch-all also read as "clean" -- the same fail-open shape as the
        // quoting bug, from a different cause. Found by the fail-closed path
        // above on the first real negative test, so keep the headroom generous.
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    // Only requested --text output is evidence for dynamic boundary filtering.
    return { status: 0, stdout: stdout ?? "", ...(textOutput ? { textOutput: true } : {}) };
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

// Exact dynamic account names that are not operator identifiers. Matching these
// as substrings false-positives on ordinary words (sandbox, checkbox, ubuntu-latest).
// Explicit private and tracked tokens remain authoritative, even for these spellings.
const GENERIC_DYNAMIC_USERNAMES = new Set([
  "agent",
  "box",
  "root",
  "ubuntu",
  "runner",
  "user",
  "admin",
  "node",
]);

function isIgnoredDynamicUsername(candidate) {
  const value = String(candidate ?? "").trim().toLowerCase();
  if (value.length < 4) return true;
  return GENERIC_DYNAMIC_USERNAMES.has(value);
}

function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates).filter((candidate) => !isIgnoredDynamicUsername(candidate));
}

function isWordChar(char) {
  return /[A-Za-z0-9_]/.test(char ?? "");
}

// Dynamic usernames are literals bounded by non-word characters. The scan still
// uses git grep -F; this filter only drops substring hits such as "box" inside
// "sandbox". Private and tracked tokens do not use this filter.
function hasWordBoundaryMatch(text, token) {
  const haystack = String(text);
  const needle = String(token);
  if (!needle) return false;
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  if (!lowerHaystack.includes(lowerNeedle)) return false;

  // Whole-string casing keeps contextual mappings. Map its UTF-16 positions
  // back to original code-point spans; the ASCII neighbor policy is unchanged.
  let mappedLength = 0;
  for (const character of haystack) mappedLength += character.toLowerCase().length;
  if (mappedLength !== lowerHaystack.length) return true;
  const startCursor = { originalStart: 0, originalEnd: 0, foldedEnd: 0 };
  const endCursor = { originalStart: 0, originalEnd: 0, foldedEnd: 0 };
  const locate = (index, cursor) => {
    // Each cursor only advances: no repeated prefix lowering or offset arrays.
    while (cursor.foldedEnd <= index) {
      if (cursor.originalEnd >= haystack.length) return null;
      cursor.originalStart = cursor.originalEnd;
      const point = haystack.codePointAt(cursor.originalStart);
      cursor.originalEnd += point > 0xffff ? 2 : 1;
      cursor.foldedEnd += haystack.slice(cursor.originalStart, cursor.originalEnd).toLowerCase().length;
    }
    return cursor;
  };
  let from = 0;
  while (from <= lowerHaystack.length - lowerNeedle.length) {
    const index = lowerHaystack.indexOf(lowerNeedle, from);
    if (index < 0) return false;
    const start = locate(index, startCursor);
    const end = locate(index + lowerNeedle.length - 1, endCursor);
    // An uncertain mapping cannot prove that a reported literal is embedded.
    if (!start || !end) return true;
    const before = start.originalStart > 0 ? haystack[start.originalStart - 1] : "";
    const after = end.originalEnd < haystack.length ? haystack[end.originalEnd] : "";
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
  return false;
}

function keepWordBoundaryLines(stdout, token) {
  // -h removes filenames; -n leaves decimal line numbers. NUL bytes or
  // malformed records are ambiguous and must remain blocking.
  if (stdout.includes("\0")) return stdout;
  return stdout.split("\n").filter((line) => {
    if (!line.trim()) return false;
    const match = /^([1-9][0-9]*):(.*)$/.exec(line);
    if (!match) return true;
    const content = match[2];
    if (!content.toLowerCase().includes(String(token).toLowerCase())) return true;
    return hasWordBoundaryMatch(content, token);
  }).join("\n");
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

function resolveForbiddenTokenScan(tokensFiles, env = process.env, osModule = os) {
  const files = Array.isArray(tokensFiles) ? tokensFiles : [tokensFiles];
  const fileTokens = uniqueNonEmpty(
    files.filter(Boolean).flatMap((file) => readForbiddenTokensFile(file)),
  );
  const literalKeys = new Set(fileTokens.map((token) => token.toLowerCase()));
  const wordBoundaryTokens = resolveDynamicForbiddenTokens(env, osModule)
    .filter((token) => !literalKeys.has(token.toLowerCase()));

  return {
    tokens: uniqueNonEmpty([...wordBoundaryTokens, ...fileTokens]),
    wordBoundaryTokens,
  };
}

function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  wordBoundaryTokens = [],
  grep = gitGrepToken,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  const boundaryKeys = new Set(wordBoundaryTokens.map((token) => token.toLowerCase()));
  let found = false;
  let dynamicReported = false;
  let broken = false;

  for (const token of tokens) {
    const result = grep({ token, repoRoot, textOutput: boundaryKeys.has(token.toLowerCase()) });
    const status = result.status;
    let stdout = result.stdout ?? "";

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

    if (status === 0 && boundaryKeys.has(token.toLowerCase())) {
      if (!stdout.trim()) {
        broken = true;
        error("ERROR: forbidden-token scan returned a positive result without classifiable output.");
        continue;
      }
      // Only the --text producer establishes text-output evidence. Injected
      // or otherwise unclassified positive output must not be discarded.
      if (result.textOutput === true) {
        stdout = keepWordBoundaryLines(stdout, token);
      }
    }

    if (status === 0 && stdout.trim()) {
      if (!found) {
        error("ERROR: Forbidden tokens found in tracked files:\n");
      }
      found = true;
      if (boundaryKeys.has(token.toLowerCase())) {
        if (!dynamicReported) error("  A dynamic forbidden-token finding was detected.");
        dynamicReported = true;
      } else {
        for (const line of stdout.trim().split("\n")) {
          error(`  ${line}`);
        }
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
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 };
  const repoRoot = exec("git rev-parse --show-toplevel", options).trim();
  const gitCommonDir = exec("git rev-parse --git-common-dir", {
    ...options,
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
  const scan = resolveForbiddenTokenScan(tokensFiles);
  process.exit(runForbiddenTokenCheck({
    repoRoot,
    tokens: scan.tokens,
    wordBoundaryTokens: scan.wordBoundaryTokens,
  }));
}

module.exports = {
  gitGrepToken,
  hasWordBoundaryMatch,
  readForbiddenTokensFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokenScan,
  resolveForbiddenTokens,
  resolveRepoPaths,
  runCli,
  runForbiddenTokenCheck,
};
