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
 * Opt-in mechanism: an immediately preceding, standalone line comment in the
 * exact form `// paperclip:allow-git-push: <reason>` (or `# ...` in POSIX
 * shell) suppresses one match. Languages with ambiguous multiline strings do
 * not accept markers. A marker inside a string, command, or trailing comment
 * does not suppress a match.
 *
 * FAIL-CLOSED CONTRACT (#76)
 * A static scanner that cannot read its subject has not cleared it. Every
 * filesystem failure below therefore stops the check and names the path it
 * could not read, instead of being swallowed into a pass:
 *
 *   * `lstatSync`/`statSync` on a scan root -> a missing required root rejects;
 *     a missing explicitly optional root is reported; any other errno rejects.
 *   * `readdirSync` mid-walk     -> always rejects. The root existed a moment
 *     ago, so a failure here means the tree changed or is unreadable, and the
 *     subtree it hides is exactly where an offense would live.
 *   * `readFileSync` on a file   -> always rejects. The file was enumerated as
 *     scannable; not reading it is an unscanned file, not a clean one.
 *   * symbolic links, tracked generated/cache directories, unknown entry
 *     kinds, and undeclared file types -> reject rather than silently dropping
 *     content. Declared generated/cache directories may be excluded only when
 *     Git proves no pushed path is tracked beneath them.
 * Coverage includes roots, directories, entries, declared documentation or
 * type-declaration exclusions, and files. A zero-file scan and any missing
 * required root are never a pass.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import {
  ALLOW_MARKER,
  findGitPushOffenses,
  scanGitPushText,
} from "./check-no-git-push-source.mjs";
import {
  ScanIntegrityError,
  assertNormalIndexState,
  containsTrackedPath,
  findUnobservedTrackedPaths,
  normalizeTrackedPathSet,
  readTrackedManifest,
  readTrackedFiles,
} from "./git-push-scan-integrity.mjs";
import { isMainModule } from "./is-main-module.mjs";

export { ScanIntegrityError, readTrackedFiles, readTrackedManifest } from "./git-push-scan-integrity.mjs";

export {
  ALLOW_MARKER,
  GIT_PUSH_PATTERN,
  GIT_PUSH_PATTERNS,
  findGitPushOffenses,
  scanGitPushText,
} from "./check-no-git-push-source.mjs";

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
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".py",
  ".cmd",
  ".bat",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
]);

const DECLARED_GENERATED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];
const DECLARED_NON_RUNTIME_EXTENSIONS = new Set([".md"]);
const DECLARED_NON_RUNTIME_FILENAMES = new Set(["LICENSE"]);

// Exit code for "the scan itself is untrustworthy", kept distinct from 1
// ("offenses found") so a caller -- and the regression tests -- can tell a real
// finding from a gate that never got to look.
export const SCAN_INTEGRITY_EXIT_CODE = 2;

// Injection seam for the regression tests. Production callers get node:fs; the
// tests substitute a facade that throws a chosen errno at a chosen path, so the
// fail-closed branches are provable deterministically on every platform rather
// than only where an ACL/permission fixture happens to reproduce.
const DEFAULT_FS = { lstatSync, statSync, readdirSync, readFileSync, realpathSync };

function toRepoRelative(repoRoot, absolute) {
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return absolute;
  return relative.split(path.sep).join("/");
}

function shouldScanFile(relativePath) {
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  const extension = path.extname(relativePath).toLowerCase();
  if (SCANNABLE_EXTENSIONS.has(extension)) return true;
  if (
    DECLARED_NON_RUNTIME_EXTENSIONS.has(extension) ||
    DECLARED_NON_RUNTIME_FILENAMES.has(path.basename(relativePath))
  ) {
    return false;
  }
  throw new ScanIntegrityError(`undeclared file type inside scan root: ${relativePath}`, {
    path: relativePath,
    code: "EUNSUPPORTED",
  });
}

function normalizeScanRoot(scanRoot) {
  if (typeof scanRoot === "string") return { path: scanRoot, required: true };
  if (
    scanRoot &&
    typeof scanRoot.path === "string" &&
    scanRoot.path.trim() !== "" &&
    typeof scanRoot.required === "boolean"
  ) {
    return { path: scanRoot.path, required: scanRoot.required };
  }
  throw new ScanIntegrityError("scan roots must be paths or { path, required } declarations", {
    code: "EINVAL",
  });
}

function resolveScanRoot(repoRoot, scanRoot) {
  const absoluteRoot = path.resolve(repoRoot, scanRoot);
  const relative = path.relative(repoRoot, absoluteRoot);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ScanIntegrityError(`scan root escapes the repository: ${scanRoot}`, {
      path: scanRoot,
      code: "EINVAL",
    });
  }
  return absoluteRoot;
}

function normalizeNativePath(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertCanonicalScanPath(absolutePath, repoRoot, fs, realRepoRootHint) {
  let realRepoRoot = realRepoRootHint;
  let realPath;
  try {
    realRepoRoot ??= fs.realpathSync(repoRoot);
    realPath = fs.realpathSync(absolutePath);
  } catch (cause) {
    throw new ScanIntegrityError(
      `cannot resolve ${toRepoRelative(repoRoot, absolutePath)}: ${cause?.code ?? cause?.message}`,
      { path: toRepoRelative(repoRoot, absolutePath), code: cause?.code },
    );
  }
  const expectedPath = path.resolve(realRepoRoot, path.relative(path.resolve(repoRoot), absolutePath));
  const relativeToRealRoot = path.relative(realRepoRoot, realPath);
  if (
    relativeToRealRoot === ".." ||
    relativeToRealRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRealRoot) ||
    normalizeNativePath(realPath) !== normalizeNativePath(expectedPath)
  ) {
    throw new ScanIntegrityError(
      `junction or symbolic-link traversal is not allowed: ${toRepoRelative(repoRoot, absolutePath)}`,
      { path: toRepoRelative(repoRoot, absolutePath), code: "ESYMLINK" },
    );
  }
  return realRepoRoot;
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
  { fs = DEFAULT_FS, onMissingRoot, coverage, trackedFiles, observedPaths } = {},
) {
  const results = [];
  let linkStats;
  try {
    linkStats = fs.lstatSync(absoluteRoot);
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
  if (linkStats.isSymbolicLink()) {
    throw new ScanIntegrityError(
      `scan root ${toRepoRelative(repoRoot, absoluteRoot)} is a symbolic link`,
      { path: toRepoRelative(repoRoot, absoluteRoot), code: "ESYMLINK" },
    );
  }

  let stats;
  try {
    stats = fs.statSync(absoluteRoot);
  } catch (cause) {
    const code = cause?.code;
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
  const realRepoRoot = assertCanonicalScanPath(absoluteRoot, repoRoot, fs);

  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    assertCanonicalScanPath(current, repoRoot, fs, realRepoRoot);
    if (coverage) coverage.directoriesVisited += 1;
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
      if (coverage) coverage.entriesInspected += 1;
      const entryPath = path.join(current, entry.name);
      const relativeEntry = toRepoRelative(repoRoot, entryPath).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        throw new ScanIntegrityError(
          `symbolic link inside scan root is not allowed: ${relativeEntry}`,
          { path: relativeEntry, code: "ESYMLINK" },
        );
      }
      if (
        DECLARED_GENERATED_DIRECTORY_NAMES.has(entry.name.toLowerCase()) &&
        entry.isDirectory()
      ) {
        if (containsTrackedPath(relativeEntry, trackedFiles)) {
          throw new ScanIntegrityError(
            `tracked generated/cache directory inside scan root requires explicit review: ${relativeEntry}`,
            { path: relativeEntry, code: "EUNSUPPORTED" },
          );
        }
        if (coverage) coverage.generatedDirectoriesExcluded += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ScanIntegrityError(
          `unsupported filesystem entry inside scan root: ${relativeEntry}`,
          { path: relativeEntry, code: "EUNSUPPORTED" },
        );
      }
      observedPaths?.add(relativeEntry);
      if (shouldScanFile(relativeEntry)) results.push({ absolute: entryPath, relative: relativeEntry });
      else if (coverage) coverage.filesSkippedByExtension += 1;
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
  trackedFiles = null,
  nonStandardIndexPaths = null,
} = {}) {
  const allOffenses = [];
  const missingRoots = [];
  const missingRequiredRoots = [];
  let scannedFileCount = 0;
  let exemptionCount = 0;
  const rootScannedCounts = new Map();
  const observedPaths = new Set();
  const coverage = {
    directoriesVisited: 0,
    entriesInspected: 0,
    filesSkippedByExtension: 0,
    generatedDirectoriesExcluded: 0,
  };
  let rootDeclarations;

  try {
    rootDeclarations = scanRoots.map(normalizeScanRoot);
    if ((trackedFiles === null) !== (nonStandardIndexPaths === null)) {
      throw new ScanIntegrityError("tracked files and index state must be supplied together", { code: "EINDEXUNKNOWN" });
    }
    const normalizedTrackedFiles = trackedFiles === null ? null : normalizeTrackedPathSet(trackedFiles);
    if (nonStandardIndexPaths !== null) {
      assertNormalIndexState(nonStandardIndexPaths, rootDeclarations.map((entry) => entry.path));
    }
    for (const declaration of rootDeclarations) {
      const scanRoot = declaration.path;
      const absoluteRoot = resolveScanRoot(repoRoot, scanRoot);
      const files = collectScannableFiles(absoluteRoot, repoRoot, {
        fs,
        coverage,
        trackedFiles: normalizedTrackedFiles,
        observedPaths,
        onMissingRoot: () => {
          missingRoots.push(scanRoot);
          if (declaration.required) missingRequiredRoots.push(scanRoot);
        },
      });
      rootScannedCounts.set(scanRoot, files.length);
      if (declaration.required && files.length === 0 && !missingRoots.includes(scanRoot)) {
        throw new ScanIntegrityError(
          `required scan root ${scanRoot} contains zero scannable files`,
          { path: scanRoot, code: "ENODATA" },
        );
      }
      for (const file of files) {
        let text;
        try {
          const contents = fs.readFileSync(file.absolute);
          if (typeof contents === "string") text = contents;
          else text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
          if (text.includes("\0")) throw new Error("NUL bytes are not valid scanner source text");
        } catch (cause) {
          throw new ScanIntegrityError(
            `cannot read or decode ${file.relative} as UTF-8: ${cause?.code ?? cause?.message}`,
            { path: file.relative, code: cause?.code ?? "EILSEQ" },
          );
        }
        scannedFileCount += 1;
        const result = scanGitPushText(text, { relativePath: file.relative });
        exemptionCount += result.exemptions;
        for (const offense of result.offenses) {
          allOffenses.push({ relative: file.relative, ...offense });
        }
      }
    }
    const unobservedTracked = findUnobservedTrackedPaths({
      trackedFiles: normalizedTrackedFiles,
      scanRoots: rootDeclarations.map((declaration) => declaration.path),
      observedPaths,
    });
    if (unobservedTracked.length > 0) {
      throw new ScanIntegrityError(
        `tracked path under scan roots was not observed in the working tree: ${unobservedTracked[0]}`,
        { path: unobservedTracked[0], code: "ETRACKEDMISSING" },
      );
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

  if (missingRequiredRoots.length > 0) {
    error(
      "ERROR: required `git push` scan roots are missing, so the check cannot report a pass:\n",
    );
    error(`  missing required roots: ${missingRequiredRoots.join(", ")}`);
    error(
      "\nRestore the declared roots or update the required/optional root contract in reviewed code.",
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
    error(`  scan roots requested: ${rootDeclarations.map((entry) => entry.path).join(", ") || "(none)"}`);
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
      `If the operator has explicitly configured a path that must push, add a standalone \`// ${ALLOW_MARKER}: <reason>\` comment immediately above the invocation.`,
    );
    return 1;
  }

  // The count is part of the pass, not decoration: it is what makes a vacuous
  // run visible to a human reading CI output.
  log(
    `  ✓  No unapproved \`git push\` invocations found in adapter/runtime code ` +
      `(${scannedFileCount} file(s) scanned; ${coverage.directoriesVisited} director${coverage.directoriesVisited === 1 ? "y" : "ies"} walked; ` +
      `${coverage.entriesInspected} filesystem entr${coverage.entriesInspected === 1 ? "y" : "ies"} inspected; ` +
      `${coverage.filesSkippedByExtension} declaration/document file(s) excluded by the declared non-runtime policy; ` +
      `${coverage.generatedDirectoriesExcluded} untracked generated/cache director${coverage.generatedDirectoriesExcluded === 1 ? "y" : "ies"} excluded by declared policy; ` +
      `${exemptionCount} reviewed exemption(s); ` +
      `${rootDeclarations.length - missingRoots.length} of ${rootDeclarations.length} scan root(s) present).`,
  );
  for (const declaration of rootDeclarations) {
    if (!missingRoots.includes(declaration.path)) {
      log(`     ${declaration.path}: ${rootScannedCounts.get(declaration.path) ?? 0} file(s) scanned`);
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  try {
    const manifest = readTrackedManifest(repoRoot);
    process.exit(runCheck({
      repoRoot,
      trackedFiles: manifest.files,
      nonStandardIndexPaths: manifest.nonStandardIndexPaths,
    }));
  } catch (error) {
    process.stderr.write(`ERROR: the \`git push\` check could not establish tracked-tree coverage:\n  ${error.message}\n`);
    process.exit(SCAN_INTEGRITY_EXIT_CODE);
  }
}
