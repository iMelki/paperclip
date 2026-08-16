import { spawnSync } from "node:child_process";
import process from "node:process";

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

export function containsTrackedPath(relativeDirectory, trackedFiles) {
  if (!trackedFiles) return true;
  const directory = normalizeRepoPathKey(relativeDirectory);
  const prefix = `${directory}/`;
  return [...trackedFiles].some((file) => {
    const candidate = normalizeRepoPathKey(file);
    return candidate === directory || candidate.startsWith(prefix);
  });
}

export function findUnobservedTrackedPaths({ trackedFiles, scanRoots, observedPaths }) {
  if (!trackedFiles) return [];
  const roots = scanRoots.map((root) => normalizeRepoPathKey(root));
  const observed = new Set([...observedPaths].map(normalizeRepoPathKey));
  return [...trackedFiles]
    .filter((file) => {
      const candidate = normalizeRepoPathKey(file);
      const inScope = roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
      return inScope && !observed.has(candidate);
    })
    .sort();
}

export function findPathsUnderRoots(paths, scanRoots) {
  const roots = scanRoots.map((root) => normalizeRepoPathKey(root));
  return [...paths].filter((file) => {
    const candidate = normalizeRepoPathKey(file);
    return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  }).sort();
}

export function assertNormalIndexState(nonStandardIndexPaths, scanRoots = null) {
  const hiddenIndexPaths = scanRoots
    ? findPathsUnderRoots(nonStandardIndexPaths, scanRoots)
    : [...nonStandardIndexPaths].sort();
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
