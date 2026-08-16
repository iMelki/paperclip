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
 *   * `statSync` on a scan root  -> ENOENT is absence. Whether that is fatal is
 *     decided by the root's DECLARATION (see below), not by tolerance; any
 *     other errno is unreadable and rejects (exit 2).
 *   * `readdirSync` mid-walk     -> always rejects. The root existed a moment
 *     ago, so a failure here means the tree changed or is unreadable, and the
 *     subtree it hides is exactly where an offense would live.
 *   * `readFileSync` on a file   -> always rejects. The file was enumerated as
 *     scannable; not reading it is an unscanned file, not a clean one.
 *   * a symlink that cannot be resolved -> always rejects. An unresolvable link
 *     hides an unknown amount of tree.
 *
 * Plus a vacuity guard: scanning zero files is never a pass.
 *
 * #76 REOPENED -- three working bypasses this file now closes. Each was
 * reproduced against the previous revision with a live control before the fix:
 *
 *   A. RENAMING ONE ROOT. `missingRoots` was merely logged, so renaming the one
 *      scan root that held the offender exited 0 printing "3 of 4 scan root(s)".
 *      Only renaming ALL FOUR tripped the vacuity guard. Absence is now resolved
 *      BY DECLARATION: every root declares itself required or optional, an
 *      absent required root is a scan-integrity failure, and a required root
 *      that exists but yields zero scannable files is too -- because "the
 *      directory is still there" is not evidence that its contents are.
 *
 *   B. DIRECTORY SYMLINK. `readdirSync(dir, { withFileTypes: true })` reports a
 *      symlink-to-directory with `isDirectory() === false`, so such an entry
 *      fell through to the FILE branch, failed the extension test on its
 *      extension-less name, and its ENTIRE SUBTREE was dropped silently -- exit
 *      0, "4 of 4 scan roots", offender readable on disk through the link. Not a
 *      Windows quirk: git stores the link as mode 120000 (verified: blob content
 *      `../../hidden`) so a Linux CI checkout materialises a real symlink and
 *      takes the same branch. The walker now resolves every symlink with a
 *      following `statSync`, traverses resolved directories, and uses a
 *      realpath-keyed visited set so a symlink cycle terminates instead of
 *      spinning.
 *
 *   C. UNSCANNED EXTENSIONS. `.mts`, `.cts` and `.jsx` were absent from
 *      SCANNABLE_EXTENSIONS, so an offender simply renamed to `.mts` was never
 *      read. Added, along with their `.d.mts`/`.d.cts` declaration counterparts.
 *
 * REPORTING. The pass line's denominator used to be `N of 4 scan root(s)` --
 * a count of ROOTS, which is why bypass B read healthy while an entire subtree
 * went unscanned. It now reports the TREE actually walked: files read,
 * directories entered, symlinks resolved, and a per-root file breakdown, so a
 * vanished subtree changes the number a human is looking at.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Every root is DECLARED. `required: true` means "this checkout is expected to
// contain this directory, populated" -- its absence, or its emptiness, is a
// scan-integrity failure rather than a line of log output. Mark a root
// `optional: true` only when a legitimately different repo layout may omit it;
// that is a reviewable claim in the diff, which blanket tolerance never was.
const DEFAULT_SCAN_ROOTS = [
  { path: "packages/adapters", required: true },
  { path: "packages/adapter-utils", required: true },
  { path: "server/src", required: true },
  { path: "cli/src", required: true },
];

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];

// Exit code for "the scan itself is untrustworthy", kept distinct from 1
// ("offenses found") so a caller -- and the regression tests -- can tell a real
// finding from a gate that never got to look.
export const SCAN_INTEGRITY_EXIT_CODE = 2;

// Injection seam for the regression tests. Production callers get node:fs; the
// tests substitute a facade that throws a chosen errno at a chosen path, so the
// fail-closed branches are provable deterministically on every platform rather
// than only where an ACL/permission fixture happens to reproduce.
const DEFAULT_FS = { statSync, readdirSync, readFileSync, realpathSync };

// Callers (and the existing regression tests) pass PARTIAL facades that override
// only the operation under test. Merging over the defaults keeps those fixtures
// working when a new operation is added here, instead of turning an untouched
// fixture into a `fs.realpathSync is not a function` crash.
function resolveFs(candidate) {
  return candidate === DEFAULT_FS ? DEFAULT_FS : { ...DEFAULT_FS, ...candidate };
}

/**
 * Normalises a scan-root declaration.
 *
 * A bare string is treated as REQUIRED. That is the fail-closed default on
 * purpose: bypass A worked because an undeclared root's disappearance was
 * tolerated, so silence must now mean "must be here", and tolerance must be
 * written down.
 */
export function normalizeScanRoot(entry) {
  if (typeof entry === "string") return { path: entry, required: true };
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
    throw new TypeError(
      `invalid scan root declaration: ${JSON.stringify(entry)} (expected a string or { path, required|optional })`,
    );
  }
  if (entry.required !== undefined && entry.optional !== undefined
    && entry.required === entry.optional) {
    throw new TypeError(
      `contradictory scan root declaration for ${entry.path}: required=${entry.required} optional=${entry.optional}`,
    );
  }
  const required = entry.required !== undefined ? Boolean(entry.required) : !entry.optional;
  return { path: entry.path, required };
}

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
  { fs: providedFs = DEFAULT_FS, onMissingRoot, visitedRealDirectories, stats: walkStats } = {},
) {
  const fs = resolveFs(providedFs);
  const results = [];
  // Keyed by realpath so a symlink cycle (a link pointing at one of its own
  // ancestors) terminates, and so the same real directory reached through two
  // different links is walked -- and counted -- exactly once.
  const visited = visitedRealDirectories ?? new Set();
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

    // Resolve before listing. This is the cycle guard, and it is also why a
    // directory reached twice through different links is not double-counted.
    let realCurrent;
    try {
      realCurrent = fs.realpathSync(current);
    } catch (cause) {
      throw new ScanIntegrityError(
        `cannot resolve directory ${toRepoRelative(repoRoot, current)}: ${cause?.code ?? cause?.message}`,
        { path: toRepoRelative(repoRoot, current), code: cause?.code },
      );
    }
    if (visited.has(realCurrent)) continue;
    visited.add(realCurrent);
    if (walkStats) walkStats.directoriesWalked += 1;

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
      const absolute = path.join(current, entry.name);

      // #76 bypass B. A Dirent describes the LINK, not its target:
      // `isDirectory()` is false for a symlink-to-directory, which is how an
      // entire subtree used to fall into the file branch and vanish. Resolve
      // with a following stat and classify by the TARGET.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (walkStats) walkStats.symlinksResolved += 1;
        let target;
        try {
          target = fs.statSync(absolute);
        } catch (cause) {
          // Includes ENOENT: a dangling link is not an empty one. The scanner
          // cannot say what is behind it, so it cannot report a pass.
          throw new ScanIntegrityError(
            `cannot resolve symlink ${toRepoRelative(repoRoot, absolute)}: ${cause?.code ?? cause?.message}`,
            { path: toRepoRelative(repoRoot, absolute), code: cause?.code },
          );
        }
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      }

      if (isDirectory) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!isFile) {
        // Sockets, FIFOs, devices and anything else exotic. Rare enough that
        // tolerating them buys nothing and hides whatever they are.
        throw new ScanIntegrityError(
          `${toRepoRelative(repoRoot, absolute)} is neither a regular file nor a directory; refusing to treat it as scanned`,
          { path: toRepoRelative(repoRoot, absolute), code: "ENOTSUP" },
        );
      }

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
  fs: providedFs = DEFAULT_FS,
} = {}) {
  const fs = resolveFs(providedFs);
  const declaredRoots = scanRoots.map(normalizeScanRoot);
  const allOffenses = [];
  const missingOptionalRoots = [];
  const missingRequiredRoots = [];
  const emptyRequiredRoots = [];
  const perRootFileCounts = new Map();
  const walkStats = { directoriesWalked: 0, symlinksResolved: 0 };
  // Shared across roots so overlapping trees are counted once, not twice.
  const visitedRealDirectories = new Set();
  let scannedFileCount = 0;

  try {
    for (const declared of declaredRoots) {
      const scanRoot = declared.path;
      const absoluteRoot = path.resolve(repoRoot, scanRoot);
      let absent = false;
      const files = collectScannableFiles(absoluteRoot, repoRoot, {
        fs,
        visitedRealDirectories,
        stats: walkStats,
        onMissingRoot: () => {
          absent = true;
          (declared.required ? missingRequiredRoots : missingOptionalRoots).push(scanRoot);
        },
      });
      perRootFileCounts.set(scanRoot, files.length);
      // A required root that is present but yields nothing is the same failure
      // as an absent one wearing a directory entry: bypass A only needed the
      // offender's root to stop being scanned, not to stop existing.
      if (!absent && declared.required && files.length === 0) {
        emptyRequiredRoots.push(scanRoot);
      }
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

  // A root DECLARED optional may legitimately be absent in a different repo
  // layout, so its absence is reported rather than fatal -- but it is reported,
  // because silence here is how the fail-open bug (#76) stayed invisible.
  if (missingOptionalRoots.length > 0) {
    log(
      `  !  Optional scan roots absent from this checkout (not scanned): ${missingOptionalRoots.join(", ")}`,
    );
  }

  // #76 bypass A. A required root that is absent, or present but empty, means
  // the tree this check is supposed to cover is not the tree it read. Renaming
  // ONE root used to leave this at "3 of 4 scan root(s)" and exit 0.
  if (missingRequiredRoots.length > 0 || emptyRequiredRoots.length > 0) {
    error(
      "ERROR: the `git push` check did not cover every scan root declared required, so it cannot report a pass.\n",
    );
    if (missingRequiredRoots.length > 0) {
      error(`  required scan roots ABSENT:            ${missingRequiredRoots.join(", ")}`);
    }
    if (emptyRequiredRoots.length > 0) {
      error(`  required scan roots with 0 scannable files: ${emptyRequiredRoots.join(", ")}`);
    }
    error(`  files scanned before this was detected: ${scannedFileCount}`);
    if (allOffenses.length > 0) {
      error("\n  Offenses found in the part of the tree that WAS read:");
      for (const offense of allOffenses) {
        error(`    ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
      }
    }
    error(
      "\nA renamed or emptied scan root is exactly how an offending file leaves this check's view. Restore the root, or declare it `{ path, optional: true }` if this layout genuinely omits it.",
    );
    return SCAN_INTEGRITY_EXIT_CODE;
  }

  // Vacuity guard. Zero files read means the check proved nothing; reporting a
  // pass would be the exact fail-open shape #76 exploited by renaming the roots.
  if (scannedFileCount === 0) {
    error(
      "ERROR: the `git push` check scanned 0 files and therefore cannot report a pass.\n",
    );
    error(`  scan roots requested: ${declaredRoots.map((r) => r.path).join(", ") || "(none)"}`);
    error(`  scan roots absent:    ${[...missingRequiredRoots, ...missingOptionalRoots].join(", ") || "(none)"}`);
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

  // The denominator is part of the pass, not decoration -- and it now describes
  // the TREE. The previous "N of 4 scan root(s)" counted roots, which is why
  // bypass B read perfectly healthy ("4 of 4") while an entire symlinked subtree
  // went unscanned. Files, directories and resolved links all move when coverage
  // moves; the per-root breakdown makes a single vanished subtree visible.
  const perRoot = declaredRoots
    .map((declared) => `${declared.path}=${perRootFileCounts.get(declared.path) ?? 0}`)
    .join(", ");
  log(
    `  ✓  No unapproved \`git push\` invocations found in adapter/runtime code `
      + `(${scannedFileCount} file(s) scanned across ${walkStats.directoriesWalked} director(ies), `
      + `${walkStats.symlinksResolved} symlink(s) resolved; per root: ${perRoot}).`,
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
