import { spawnSync } from "node:child_process";
import process from "node:process";

export const GIT_CHILD_MAX_BUFFER = 64 * 1024 * 1024;
export const GIT_CHILD_TIMEOUT_MS = 120_000;

export class ScanIntegrityError extends Error {
  constructor(message, { path: failedPath, code } = {}) {
    super(message);
    this.name = "ScanIntegrityError";
    this.path = failedPath;
    this.code = code;
  }
}

export function normalizeRepoPathKey(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeTrackedPathSet(trackedFiles) {
  if (!trackedFiles) return trackedFiles;
  return new Set([...trackedFiles].map(normalizeRepoPathKey));
}

export function containsTrackedPath(relativeDirectory, normalizedTrackedFiles) {
  if (!normalizedTrackedFiles) return true;
  const directory = normalizeRepoPathKey(relativeDirectory);
  const prefix = `${directory}/`;
  return [...normalizedTrackedFiles].some(
    (candidate) => candidate === directory || candidate.startsWith(prefix),
  );
}

export function findUnobservedTrackedPaths({
  trackedFiles: normalizedTrackedFiles,
  scanRoots,
  observedPaths,
}) {
  if (!normalizedTrackedFiles) return [];
  const roots = scanRoots.map((root) => normalizeRepoPathKey(root));
  const observed = new Set([...observedPaths].map(normalizeRepoPathKey));
  return [...normalizedTrackedFiles]
    .filter((candidate) => {
      const inScope = roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
      return inScope && !observed.has(candidate);
    })
    .sort();
}

export function findPathsUnderRoots(normalizedPaths, scanRoots) {
  const roots = scanRoots.map((root) => normalizeRepoPathKey(root));
  return [...normalizedPaths].filter((candidate) => {
    return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  }).sort();
}

export function assertNormalIndexState(nonStandardIndexPaths, scanRoots = null) {
  if (nonStandardIndexPaths == null) {
    throw new ScanIntegrityError(
      "index state was not supplied; a tracked manifest must provide both tracked files and index state",
      { code: "EINDEXUNKNOWN" },
    );
  }
  const normalizedIndexPaths = normalizeTrackedPathSet(nonStandardIndexPaths);
  const hiddenIndexPaths = scanRoots
    ? findPathsUnderRoots(normalizedIndexPaths, scanRoots)
    : [...normalizedIndexPaths].sort();
  if (hiddenIndexPaths.length > 0) {
    const scope = scanRoots ? " under scan roots" : "";
    throw new ScanIntegrityError(
      `tracked path${scope} has a hidden or non-normal index state: ${hiddenIndexPaths[0]}`,
      { path: hiddenIndexPaths[0], code: "EINDEXHIDDEN" },
    );
  }
}

export function parseTrackedManifest(output, repoRoot = ".") {
  const files = new Set();
  const nonStandardIndexPaths = new Set();
  for (const record of Buffer.from(output ?? "").toString("utf8").split("\0").filter(Boolean)) {
    const match = record.match(/^([^ ]) (.+)$/s);
    if (!match) {
      throw new ScanIntegrityError(`cannot parse tracked-file manifest record: ${record}`, {
        path: repoRoot,
        code: "EGIT",
      });
    }
    const [, tag, rawPath] = match;
    const file = rawPath.replaceAll("\\", "/");
    files.add(file);
    if (tag !== "H") nonStandardIndexPaths.add(file);
  }
  return { files, nonStandardIndexPaths };
}

export function readTrackedManifest(repoRoot, spawn = spawnSync) {
  const result = spawn("git", ["-C", repoRoot, "ls-files", "-v", "-z"], {
    encoding: null,
    killSignal: "SIGKILL",
    maxBuffer: GIT_CHILD_MAX_BUFFER,
    timeout: GIT_CHILD_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new ScanIntegrityError(
      `cannot enumerate tracked files: ${result.error?.message ?? `git exited ${result.status ?? "unknown"}`}`,
      { path: repoRoot, code: result.error?.code ?? "EGIT" },
    );
  }
  return parseTrackedManifest(result.stdout, repoRoot);
}

export function readTrackedFiles(repoRoot, spawn = spawnSync) {
  return readTrackedManifest(repoRoot, spawn).files;
}
