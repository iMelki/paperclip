#!/usr/bin/env node
/**
 * check-no-git-push.mjs
 *
 * Static check that rejects `git push` (and equivalent remote-mutating git
 * invocations) inside adapter/runtime source code.
 *
 * Adapter and runtime code may never push to a git remote: the local
 * execution-workspace cwd is the only persistence boundary between runs
 * (see packages/adapters/AUTHORING.md and PAPA-432). Release tooling and
 * developer scripts that legitimately push are out of scope because they
 * live outside the directories scanned here.
 *
 * Opt-in mechanism: a line containing `paperclip:allow-git-push` (typically
 * inside a `// paperclip:allow-git-push: <reason>` comment on the line itself
 * or the line immediately above) suppresses the match. This is reserved for
 * operator-configured paths that legitimately push and must be reviewed.
 *
 * FAIL-CLOSED CONTRACT (#76)
 * A static scanner that cannot read its subject has not cleared it. Every
 * filesystem failure below therefore stops the check and names the path it
 * could not read, instead of being swallowed into a pass:
 *
 *   * `statSync` on a scan root  -> ENOENT is a legitimately absent optional
 *     directory (reported, scan continues); any other errno is unreadable and
 *     rejects (exit 2).
 *   * `readdirSync` mid-walk     -> always rejects. The root existed a moment
 *     ago, so a failure here means the tree changed or is unreadable, and the
 *     subtree it hides is exactly where an offense would live.
 *   * `readFileSync` on a file   -> always rejects. The file was enumerated as
 *     scannable; not reading it is an unscanned file, not a clean one.
 *
 * Plus a vacuity guard: scanning zero files is never a pass. Before this,
 * renaming all four scan roots made the check exit 0 printing "No unapproved
 * `git push` invocations found" having read nothing at all.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "packages/adapters",
  "packages/adapter-utils",
  "server/src",
  "cli/src",
];

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts"];

// Exit code for "the scan itself is untrustworthy", kept distinct from 1
// ("offenses found") so a caller -- and the regression tests -- can tell a real
// finding from a gate that never got to look.
export const SCAN_INTEGRITY_EXIT_CODE = 2;

// Injection seam for the regression tests. Production callers get node:fs; the
// tests substitute a facade that throws a chosen errno at a chosen path, so the
// fail-closed branches are provable deterministically on every platform rather
// than only where an ACL/permission fixture happens to reproduce.
const DEFAULT_FS = { statSync, readdirSync, readFileSync };

export class ScanIntegrityError extends Error {
  constructor(message, { path: failedPath, code } = {}) {
    super(message);
    this.name = "ScanIntegrityError";
    this.path = failedPath;
    this.code = code;
  }
}

function toRepoRelative(repoRoot, absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative.startsWith("..")) return absolute;
  return relative.split(path.sep).join("/");
}

// Matches actual git push invocations in either:
//   `git push ...` (shell command string)
//   ["git", "push", ...] (args-array form for execSync)
//   execFile("git", ["push", ...]) / spawn("git", ["push", ...])
export const GIT_PUSH_PATTERNS = [
  /\bgit[\s_-]+push\b/i,
  /["'`]git["'`]\s*,\s*\[?\s*["'`]push["'`]/i,
];
// Kept for backwards-compatibility with existing tests/importers.
export const GIT_PUSH_PATTERN = GIT_PUSH_PATTERNS[0];
export const ALLOW_MARKER = "paperclip:allow-git-push";

function lineMatchesGitPush(line) {
  return GIT_PUSH_PATTERNS.some((pattern) => pattern.test(line));
}

function stripLineComment(line) {
  // Strip everything from the first `//` that is not inside a string literal.
  // This is a lightweight heuristic: we only need to remove obvious doc-style
  // mentions of "git push" so they do not trip the check. The check still
  // flags any match that survives comment stripping.
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    // A character is escaped only if it's preceded by an odd number of
    // backslashes; e.g. `"foo\\"` ends a string because the trailing `\\`
    // is a single escaped backslash, leaving the closing `"` unescaped.
    let backslashes = 0;
    for (let scan = index - 1; scan >= 0 && line[scan] === "\\"; scan -= 1) {
      backslashes += 1;
    }
    const isEscaped = backslashes % 2 === 1;

    if (!inDouble && !inBacktick && char === "'" && !isEscaped) inSingle = !inSingle;
    else if (!inSingle && !inBacktick && char === '"' && !isEscaped) inDouble = !inDouble;
    else if (!inSingle && !inDouble && char === "`" && !isEscaped) inBacktick = !inBacktick;
    else if (!inSingle && !inDouble && !inBacktick && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

export function findGitPushOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = stripLineComment(line);
    if (!lineMatchesGitPush(stripped)) continue;

    const previousLine = index > 0 ? lines[index - 1] : "";
    const isAllowed = line.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER);
    if (isAllowed) continue;

    offenses.push({ lineNumber: index + 1, line: line.trimEnd() });
  }

  return offenses;
}

function shouldScanFile(relativePath) {
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  const extension = path.extname(relativePath);
  return SCANNABLE_EXTENSIONS.has(extension);
}

/**
 * Walks one scan root and returns its scannable files.
 *
 * Returns `[]` only for a root that is genuinely absent (ENOENT) -- an optional
 * directory in a different repo layout. Every other filesystem failure throws
 * `ScanIntegrityError` naming the path, because an unreadable subtree is not an
 * empty one. `onMissingRoot` lets the caller distinguish the two without a
 * second stat.
 */
export function collectScannableFiles(
  absoluteRoot,
  repoRoot,
  { fs = DEFAULT_FS, onMissingRoot } = {},
) {
  const results = [];
  let stats;
  try {
    stats = fs.statSync(absoluteRoot);
  } catch (cause) {
    const code = cause?.code;
    if (code === "ENOENT") {
      onMissingRoot?.(toRepoRelative(repoRoot, absoluteRoot));
      return results;
    }
    throw new ScanIntegrityError(
      `cannot stat scan root ${toRepoRelative(repoRoot, absoluteRoot)}: ${code ?? cause?.message}`,
      { path: toRepoRelative(repoRoot, absoluteRoot), code },
    );
  }
  if (!stats.isDirectory()) {
    throw new ScanIntegrityError(
      `scan root ${toRepoRelative(repoRoot, absoluteRoot)} exists but is not a directory`,
      { path: toRepoRelative(repoRoot, absoluteRoot), code: "ENOTDIR" },
    );
  }

  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (cause) {
      throw new ScanIntegrityError(
        `cannot list directory ${toRepoRelative(repoRoot, current)}: ${cause?.code ?? cause?.message}`,
        { path: toRepoRelative(repoRoot, current), code: cause?.code },
      );
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (shouldScanFile(relative)) results.push({ absolute, relative });
    }
  }

  return results;
}

export function runCheck({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  log = console.log,
  error = console.error,
  fs = DEFAULT_FS,
} = {}) {
  const allOffenses = [];
  const missingRoots = [];
  let scannedFileCount = 0;

  try {
    for (const scanRoot of scanRoots) {
      const absoluteRoot = path.resolve(repoRoot, scanRoot);
      const files = collectScannableFiles(absoluteRoot, repoRoot, {
        fs,
        onMissingRoot: () => missingRoots.push(scanRoot),
      });
      for (const file of files) {
        let text;
        try {
          text = fs.readFileSync(file.absolute, "utf8");
        } catch (cause) {
          throw new ScanIntegrityError(
            `cannot read ${file.relative}: ${cause?.code ?? cause?.message}`,
            { path: file.relative, code: cause?.code },
          );
        }
        scannedFileCount += 1;
        const offenses = findGitPushOffenses(text);
        for (const offense of offenses) {
          allOffenses.push({ relative: file.relative, ...offense });
        }
      }
    }
  } catch (cause) {
    if (!(cause instanceof ScanIntegrityError)) throw cause;
    error(
      `ERROR: the \`git push\` check could not read what it is supposed to scan, so it cannot report a pass:\n`,
    );
    error(`  ${cause.message}`);
    error(
      "\nThis is a scan-integrity failure, not a clean result. Fix the unreadable path (permissions, a partially deleted tree, a broken link) and re-run.",
    );
    return SCAN_INTEGRITY_EXIT_CODE;
  }

  // A legitimately different repo layout may not have every optional root, so a
  // missing root is reported rather than fatal -- but it is reported, because
  // silence here is how the fail-open bug (#76) stayed invisible.
  if (missingRoots.length > 0) {
    log(`  !  Scan roots absent from this checkout (not scanned): ${missingRoots.join(", ")}`);
  }

  // Vacuity guard. Zero files read means the check proved nothing; reporting a
  // pass would be the exact fail-open shape #76 exploited by renaming the roots.
  if (scannedFileCount === 0) {
    error(
      "ERROR: the `git push` check scanned 0 files and therefore cannot report a pass.\n",
    );
    error(`  scan roots requested: ${scanRoots.join(", ") || "(none)"}`);
    error(`  scan roots absent:    ${missingRoots.join(", ") || "(none)"}`);
    error(
      "\nEither the scan roots were renamed/removed, or the configured roots contain no scannable source. Restore the roots or pass the correct `scanRoots`.",
    );
    return SCAN_INTEGRITY_EXIT_CODE;
  }

  if (allOffenses.length > 0) {
    error("ERROR: `git push` (or equivalent remote-mutating git command) found in adapter/runtime code:\n");
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
    }
    error(
      "\nAdapter and runtime code must not push to a git remote. The local execution-workspace cwd is the only persistence boundary between runs (see packages/adapters/AUTHORING.md and PAPA-432).",
    );
    error(
      `If the operator has explicitly configured a path that must push, add a \`${ALLOW_MARKER}: <reason>\` comment on the matching line or the line immediately above to opt in.`,
    );
    return 1;
  }

  // The count is part of the pass, not decoration: it is what makes a vacuous
  // run visible to a human reading CI output.
  log(
    `  ✓  No unapproved \`git push\` invocations found in adapter/runtime code (${scannedFileCount} file(s) scanned across ${scanRoots.length - missingRoots.length} of ${scanRoots.length} scan root(s)).`,
  );
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}
