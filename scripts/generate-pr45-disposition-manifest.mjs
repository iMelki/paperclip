#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DISPOSITIONS,
  classifyPath,
} from "./lib/pr45-disposition-policy.mjs";
import { parseUnifiedZeroPatch } from "./lib/unified-zero-patch.mjs";

export { classifyPath, parseUnifiedZeroPatch };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, "doc", "evidence", "pr45-disposition");
export const MANIFEST_PATH = path.join(
  EVIDENCE_DIR,
  "2026-09-01-pr45-no-loss-disposition.json",
);
export const SUMMARY_PATH = path.join(
  EVIDENCE_DIR,
  "2026-09-01-pr45-no-loss-disposition.md",
);

export const COMPARISON_COMMIT = "f8e718e4a4ae5bae9fb570aff59b56c89fe1a715";
export const SOURCE_REF = "wip/coordination-engine-20260802";
export const SOURCE_REF_EXPECTED_HEAD = "7bae4af253dfd96ac8a4d44807b479bcece01865";
export const SOURCE_REF_EXPECTED_MERGE_BASE = "a8f5370cf02b200b0c1210f4bf6b0c59c057fdf7";
export const PRESERVATION_REF_FETCH_COMMAND =
  `git fetch --no-tags origin ` +
  `+refs/heads/${SOURCE_REF}:refs/remotes/origin/${SOURCE_REF}`;
export const PRESERVATION_LOCAL_BRANCH_CREATE_COMMAND =
  `git branch --no-track ${SOURCE_REF} ${SOURCE_REF_EXPECTED_HEAD}`;
export const PRESERVED_COMMITS = [
  {
    sha: "36ba7d088ac3207b2a2fe2054d8ecaebc59385ab",
    mode: "first-parent-unified-zero",
    expectedPaths: 107,
    expectedHunks: 1008,
  },
  {
    sha: "5cba756912b584fb8c655c7981315efabe9d1819",
    mode: "first-parent-unified-zero",
    expectedPaths: 5,
    expectedHunks: 20,
  },
  {
    sha: "0f23e79ad90b040890242d66a4cc77d84fc353c8",
    mode: "first-parent-unified-zero",
    expectedPaths: 2,
    expectedHunks: 4,
  },
  {
    sha: "7bae4af253dfd96ac8a4d44807b479bcece01865",
    mode: "remerge-diff-unified-zero",
    expectedPaths: 48,
    expectedHunks: 2000,
    expectedConflictPaths: 4,
  },
];

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.status === 0 ? result.stdout : null;
}

function gitLine(args) {
  return git(args).trim();
}

export function getPreservationRefSupport() {
  const localHead = git(
    ["rev-parse", "--verify", `refs/heads/${SOURCE_REF}^{commit}`],
    { allowFailure: true },
  )?.trim() ?? null;
  const remoteTrackingHead = git(
    ["rev-parse", "--verify", `refs/remotes/origin/${SOURCE_REF}^{commit}`],
    { allowFailure: true },
  )?.trim() ?? null;
  const computedMergeBase = localHead && remoteTrackingHead
    ? git(
        ["merge-base", COMPARISON_COMMIT, SOURCE_REF_EXPECTED_HEAD],
        { allowFailure: true },
      )?.trim() ?? null
    : null;
  const missing = [];
  if (!localHead) missing.push(`refs/heads/${SOURCE_REF}`);
  if (!remoteTrackingHead) missing.push(`refs/remotes/origin/${SOURCE_REF}`);
  if (!computedMergeBase) missing.push("full merge-base history");
  const supported = missing.length === 0;
  return {
    supported,
    localHead,
    remoteTrackingHead,
    computedMergeBase,
    reason: supported
      ? null
      : `PR #45 custody evidence requires ${missing.join(", ")}. ` +
        `If the checkout is shallow, run 'git fetch --unshallow origin' first. ` +
        `Then run '${PRESERVATION_REF_FETCH_COMMAND}'. If the local preservation branch is missing, ` +
        `first verify the fetched remote-tracking ref resolves to ${SOURCE_REF_EXPECTED_HEAD}, then run ` +
        `'${PRESERVATION_LOCAL_BRANCH_CREATE_COMMAND}'. Never force-update an existing local preservation branch.`,
  };
}

function objectExists(spec) {
  return git(["cat-file", "-e", spec], { allowFailure: true }) !== null;
}

function readBlob(commit, filePath) {
  const spec = `${commit}:${filePath}`;
  if (!objectExists(spec)) return null;
  return {
    oid: gitLine(["rev-parse", spec]),
    text: git(["show", spec]).replace(/\r\n/g, "\n"),
  };
}

function countOccurrences(text, block) {
  if (!block) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(block, offset)) !== -1) {
    count += 1;
    offset += block.length;
  }
  return count;
}

function signedChangeLines(hunk, prefix) {
  return hunk.patchLines.filter((line) => line.startsWith(prefix));
}

function hasExactNamedCommitHunk(commit, filePath, hunk, diffCache) {
  if (!diffCache.has(commit)) {
    const patch = git([
      "show",
      "--format=",
      "--no-ext-diff",
      "--no-renames",
      "--unified=0",
      commit,
    ]).replace(/\r\n/g, "\n");
    diffCache.set(commit, parseUnifiedZeroPatch(patch));
  }
  const additions = signedChangeLines(hunk, "+");
  const removals = signedChangeLines(hunk, "-");
  return diffCache.get(commit).some((candidatePath) =>
    candidatePath.path === filePath && candidatePath.hunks.some((candidateHunk) =>
      JSON.stringify(signedChangeLines(candidateHunk, "+")) === JSON.stringify(additions) &&
      JSON.stringify(signedChangeLines(candidateHunk, "-")) === JSON.stringify(removals)));
}

function exactResultEvidence(
  hunk,
  filePath,
  candidateCommits,
  blobCache,
  firstParentCache,
  diffCache,
) {
  const additions = hunk.patchLines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
  if (additions.length === 0) return null;
  const removals = hunk.patchLines.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  const addedBlock = additions.join("\n");
  const removedBlock = removals.join("\n");
  const readCached = (commit) => {
    const key = `${commit}:${filePath}`;
    if (!blobCache.has(key)) blobCache.set(key, readBlob(commit, filePath));
    return blobCache.get(key);
  };
  const current = readCached(COMPARISON_COMMIT);
  if (!current?.text.includes(addedBlock)) return null;
  if (removedBlock && current.text.includes(removedBlock)) return null;
  if (countOccurrences(current.text, addedBlock) !== 1) return null;
  for (const evidence of candidateCommits) {
    const candidate = readCached(evidence.sha);
    if (!candidate || candidate.oid !== current.oid) continue;
    if (!hasExactNamedCommitHunk(evidence.sha, filePath, hunk, diffCache)) continue;
    if (!candidate.text.includes(addedBlock)) continue;
    if (removedBlock && candidate.text.includes(removedBlock)) continue;
    if (!firstParentCache.has(evidence.sha)) {
      const firstParent = gitLine(["show", "-s", "--format=%P", evidence.sha])
        .split(" ")
        .filter(Boolean)[0] ?? null;
      firstParentCache.set(evidence.sha, firstParent);
    }
    const firstParent = firstParentCache.get(evidence.sha);
    if (!firstParent) continue;
    const parent = readCached(firstParent);
    if (removedBlock && countOccurrences(parent?.text ?? "", removedBlock) !== 1) continue;
    const parentAlreadyHasResult =
      parent?.text.includes(addedBlock) &&
      (!removedBlock || !parent.text.includes(removedBlock));
    if (parentAlreadyHasResult) continue;
    return {
      kind: "exact-hunk-change-in-named-commit-and-identical-current-blob",
      comparisonCommit: COMPARISON_COMMIT,
      comparisonBlob: current.oid,
      landedByPr: evidence.pr,
      landedByCommit: evidence.sha,
      landedBlob: candidate.oid,
      landedCommitFirstParent: firstParent,
      firstParentBlob: parent?.oid ?? null,
    };
  }
  return null;
}

function commitPatch(commit) {
  if (commit.mode === "remerge-diff-unified-zero") {
    return git([
      "show",
      "--remerge-diff",
      "--format=",
      "--no-ext-diff",
      "--no-renames",
      "--unified=0",
      commit.sha,
    ]);
  }
  return git([
    "show",
    "--format=",
    "--no-ext-diff",
    "--no-renames",
    "--unified=0",
    commit.sha,
  ]);
}

function buildCommitRecord(commit, blobCache, firstParentCache, diffCache) {
  const rawPatch = commitPatch(commit).replace(/\r\n/g, "\n");
  const conflictMessages = rawPatch
    .split("\n")
    .filter((line) => line.startsWith("remerge CONFLICT"));
  const conflictPaths = new Set(
    conflictMessages.map((line) => line.match(/ in (.+)$/)?.[1]).filter(Boolean),
  );
  const parsedPaths = parseUnifiedZeroPatch(rawPatch, conflictPaths);
  const mergeArtifact = commit.mode === "remerge-diff-unified-zero";
  const paths = parsedPaths.map((pathRecord) => {
    const ownership = classifyPath(pathRecord.path, { mergeArtifact });
    const hunks = pathRecord.hunks.map((hunk) => {
      const evidence = mergeArtifact
        ? null
        : exactResultEvidence(
            hunk,
            pathRecord.path,
            ownership.landedEvidence,
            blobCache,
            firstParentCache,
            diffCache,
          );
      return {
        index: hunk.index,
        header: hunk.header,
        patchSha256: hunk.patchSha256,
        addedLines: hunk.addedLines,
        removedLines: hunk.removedLines,
        ownerCluster: ownership.ownerCluster,
        ownerIssues: ownership.ownerIssues,
        disposition: evidence ? "landed-with-evidence" : ownership.disposition,
        evidence,
      };
    });
    const allLanded = hunks.length > 0 && hunks.every((hunk) => hunk.disposition === "landed-with-evidence");
    return {
      path: pathRecord.path,
      changeType: pathRecord.changeType,
      indexLine: pathRecord.indexLine,
      conflictResolution: pathRecord.conflictResolution,
      ownerCluster: ownership.ownerCluster,
      ownerIssues: ownership.ownerIssues,
      disposition: allLanded ? "landed-with-evidence" : ownership.disposition,
      hunks,
    };
  });
  return {
    sha: commit.sha,
    subject: gitLine(["show", "-s", "--format=%s", commit.sha]),
    committedAt: gitLine(["show", "-s", "--format=%cI", commit.sha]),
    parents: gitLine(["show", "-s", "--format=%P", commit.sha]).split(" ").filter(Boolean),
    tree: gitLine(["show", "-s", "--format=%T", commit.sha]),
    evidenceMode: commit.mode,
    sourcePatchSha256: sha256(rawPatch),
    conflictMessages,
    paths,
    totals: {
      paths: paths.length,
      hunks: paths.reduce((sum, entry) => sum + entry.hunks.length, 0),
      conflictPaths: paths.filter((entry) => entry.conflictResolution).length,
    },
  };
}

function countDispositions(commits) {
  const counts = Object.fromEntries([...DISPOSITIONS].map((value) => [value, 0]));
  for (const commit of commits) {
    for (const pathRecord of commit.paths) {
      for (const hunk of pathRecord.hunks) counts[hunk.disposition] += 1;
    }
  }
  return counts;
}

export function buildManifest() {
  const preservationSupport = getPreservationRefSupport();
  if (!preservationSupport.supported) {
    throw new Error(preservationSupport.reason);
  }
  const blobCache = new Map();
  const firstParentCache = new Map();
  const diffCache = new Map();
  const commits = PRESERVED_COMMITS.map((commit) =>
    buildCommitRecord(commit, blobCache, firstParentCache, diffCache));
  const allPaths = commits.flatMap((commit) => commit.paths.map((entry) => entry.path));
  const allPathRecords = commits.flatMap((commit) => commit.paths);
  const allHunks = allPathRecords.flatMap((entry) => entry.hunks);
  const unownedRows =
    allPathRecords.filter((entry) => !entry.ownerCluster || entry.ownerIssues.length === 0).length +
    allHunks.filter((entry) => !entry.ownerCluster || entry.ownerIssues.length === 0).length;
  const unknownDispositions =
    allPathRecords.filter((entry) => !DISPOSITIONS.has(entry.disposition)).length +
    allHunks.filter((entry) => !DISPOSITIONS.has(entry.disposition)).length;
  const pullRequestMergeBase = preservationSupport.computedMergeBase;
  const netPullRequestPaths = git([
    "diff",
    "--name-only",
    "--no-renames",
    `${pullRequestMergeBase}..${SOURCE_REF_EXPECTED_HEAD}`,
  ]).trim().split("\n").filter(Boolean).length;
  const manifest = {
    schemaVersion: 1,
    evidenceAsOf: "2026-09-01",
    repository: "iMelki/paperclip",
    pullRequest: 45,
    ownerIssue: "https://github.com/iMelki/paperclip/issues/80",
    comparisonCommit: COMPARISON_COMMIT,
    preservationRef: {
      name: SOURCE_REF,
      expectedHead: SOURCE_REF_EXPECTED_HEAD,
      expectedMergeBase: SOURCE_REF_EXPECTED_MERGE_BASE,
      computedMergeBase: pullRequestMergeBase,
      localHead: preservationSupport.localHead,
      remoteTrackingHead: preservationSupport.remoteTrackingHead,
    },
    mutationIntent: "none",
    prohibitions: [
      "wholesale merge is forbidden",
      "wholesale cherry-pick is forbidden",
      "source-branch deletion is forbidden without separate explicit approval",
      "stash mutation is forbidden",
      "preservation-checkout or evidence retirement is forbidden",
    ],
    commits,
    totals: {
      commitCount: commits.length,
      commitPathRows: allPaths.length,
      uniqueHistoricalPaths: new Set(allPaths).size,
      netPullRequestPaths,
      hunks: commits.reduce((sum, commit) => sum + commit.totals.hunks, 0),
      conflictPaths: commits.reduce((sum, commit) => sum + commit.totals.conflictPaths, 0),
      dispositions: countDispositions(commits),
      unownedRows,
      unknownDispositions,
    },
    regeneration: {
      write: "node scripts/generate-pr45-disposition-manifest.mjs --write",
      check: "node scripts/generate-pr45-disposition-manifest.mjs --check",
    },
  };
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest.preservationRef?.localHead !== SOURCE_REF_EXPECTED_HEAD) {
    errors.push("local preservation ref does not resolve to the expected four-commit head");
  }
  if (manifest.preservationRef?.remoteTrackingHead !== SOURCE_REF_EXPECTED_HEAD) {
    errors.push("remote-tracking preservation ref does not resolve to the expected four-commit head");
  }
  if (manifest.preservationRef?.computedMergeBase !== SOURCE_REF_EXPECTED_MERGE_BASE) {
    errors.push("preservation ref merge base does not match the pinned PR base");
  }
  for (let index = 0; index < PRESERVED_COMMITS.length; index += 1) {
    const expected = PRESERVED_COMMITS[index];
    const actual = manifest.commits[index];
    if (actual?.sha !== expected.sha) errors.push(`commit ${index} SHA mismatch`);
    if (actual?.totals.paths !== expected.expectedPaths) {
      errors.push(`${expected.sha.slice(0, 8)} paths ${actual?.totals.paths} != ${expected.expectedPaths}`);
    }
    if (actual?.totals.hunks !== expected.expectedHunks) {
      errors.push(`${expected.sha.slice(0, 8)} hunks ${actual?.totals.hunks} != ${expected.expectedHunks}`);
    }
    if ((actual?.totals.conflictPaths ?? 0) !== (expected.expectedConflictPaths ?? 0)) {
      errors.push(`${expected.sha.slice(0, 8)} conflict-path count mismatch`);
    }
  }
  for (const commit of manifest.commits) {
    const mergeArtifact = commit.evidenceMode === "remerge-diff-unified-zero";
    const seenPaths = new Set();
    for (const pathRecord of commit.paths) {
      if (seenPaths.has(pathRecord.path)) errors.push(`${commit.sha}: duplicate path ${pathRecord.path}`);
      seenPaths.add(pathRecord.path);
      if (!pathRecord.ownerCluster || pathRecord.ownerIssues.length === 0) {
        errors.push(`${commit.sha}:${pathRecord.path}: unowned path`);
      }
      if (!DISPOSITIONS.has(pathRecord.disposition)) {
        errors.push(`${commit.sha}:${pathRecord.path}: invalid path disposition`);
      }
      pathRecord.hunks.forEach((hunk, hunkIndex) => {
        if (hunk.index !== hunkIndex + 1) errors.push(`${commit.sha}:${pathRecord.path}: hunk order`);
        if (!/^[0-9a-f]{64}$/.test(hunk.patchSha256)) {
          errors.push(`${commit.sha}:${pathRecord.path}:${hunk.index}: invalid patch hash`);
        }
        if (!hunk.ownerCluster || hunk.ownerIssues.length === 0) {
          errors.push(`${commit.sha}:${pathRecord.path}:${hunk.index}: unowned hunk`);
        }
        if (!DISPOSITIONS.has(hunk.disposition)) {
          errors.push(`${commit.sha}:${pathRecord.path}:${hunk.index}: invalid hunk disposition`);
        }
        if (mergeArtifact && hunk.disposition !== "semantically rederive") {
          errors.push(`${commit.sha}:${pathRecord.path}:${hunk.index}: unsafe merge-hunk disposition`);
        }
      });
    }
  }
  if (manifest.totals.commitPathRows !== 162) errors.push("commit-path total must remain 162");
  if (manifest.totals.uniqueHistoricalPaths !== 131) {
    errors.push("unique historical-path total must remain 131");
  }
  if (manifest.totals.netPullRequestPaths !== 130) {
    errors.push("net pull-request path total must remain 130");
  }
  if (manifest.totals.hunks !== 3032) errors.push("hunk total must remain 3032");
  if (manifest.totals.conflictPaths !== 4) errors.push("conflict-path total must remain 4");
  if (manifest.totals.unownedRows !== 0) errors.push("unowned rows must remain zero");
  if (manifest.totals.unknownDispositions !== 0) errors.push("unknown dispositions must remain zero");
  if (errors.length > 0) throw new Error(`PR #45 manifest validation failed:\n- ${errors.join("\n- ")}`);
  return true;
}

function renderSummary(manifest) {
  const rows = manifest.commits.map((commit) => {
    const dispositions = Object.entries(countDispositions([commit]))
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name}: ${count}`)
      .join("; ");
    return (
      `| \`${commit.sha.slice(0, 8)}\` | ${commit.evidenceMode} | ` +
      `${commit.totals.paths} | ${commit.totals.hunks} | ` +
      `${commit.totals.conflictPaths} | ${dispositions} |`
    );
  });
  const open = Object.entries(manifest.totals.dispositions)
    .filter(([name]) => name !== "landed-with-evidence")
    .map(([name, count]) => `- **${name}:** ${count} hunks remain owned extraction or redesign work.`);
  return `# PR #45 No-Loss Disposition Evidence\n\n` +
    `This evidence turns the four preserved PR #45 commits into a finite, machine-checkable census. ` +
    `It does **not** authorize a merge, cherry-pick, branch deletion, stash mutation, or evidence retirement.\n\n` +
    `- Owner: [Paperclip #80](https://github.com/iMelki/paperclip/issues/80)\n` +
    `- Comparison commit: \`${manifest.comparisonCommit}\`\n` +
    `- Preserved source ref: \`${manifest.preservationRef.name}\` at ` +
    `\`${manifest.preservationRef.expectedHead}\` (local and remote-tracking refs match)\n` +
    `- Commit-path rows: ${manifest.totals.commitPathRows}\n` +
    `- Unique historical paths across the four commits: ${manifest.totals.uniqueHistoricalPaths}\n` +
    `- Net paths in the final PR diff: ${manifest.totals.netPullRequestPaths}\n` +
    `- Unified-zero hunks: ${manifest.totals.hunks}\n` +
    `- Declared merge-conflict paths: ${manifest.totals.conflictPaths}\n` +
    `- Unowned rows: ${manifest.totals.unownedRows}\n` +
    `- Unknown dispositions: ${manifest.totals.unknownDispositions}\n\n` +
    `## Commit Census\n\n` +
    `| Commit | Evidence mode | Paths | Hunks | Conflict paths | Hunk dispositions |\n` +
    `| --- | --- | ---: | ---: | ---: | --- |\n${rows.join("\n")}\n\n` +
    `## What Is Still Open\n\n${open.join("\n")}\n\n` +
    `A \`selective-extraction candidate\` is preserved source material that still needs ` +
    `narrow current-\`dev\` review. A \`semantically rederive\` row carries useful intent ` +
    `but must be redesigned against current contracts rather than copied. ` +
    `\`landed-with-evidence\` requires the exact hunk result in both a named merged PR ` +
    `commit and the pinned comparison tree. Every remerge-diff hunk is conservatively ` +
    `\`semantically rederive\`: Git's reconstructed-merge comparison can contain meaningful ` +
    `manual conflict resolution, so none is declared stale without path-specific proof.\n\n` +
    `## Hard Safety Boundary\n\n${manifest.prohibitions.map((item) => `- ${item}.`).join("\n")}\n\n` +
    `## Reproduce\n\n` +
    `- Write: \`${manifest.regeneration.write}\`\n` +
    `- Check: \`${manifest.regeneration.check}\`\n`;
}

function canonicalJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeEvidence(manifest) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, canonicalJson(manifest), "utf8");
  writeFileSync(SUMMARY_PATH, renderSummary(manifest), "utf8");
}

export function checkEvidence(manifest) {
  const expected = [
    [MANIFEST_PATH, canonicalJson(manifest)],
    [SUMMARY_PATH, renderSummary(manifest)],
  ];
  for (const [filePath, content] of expected) {
    if (!existsSync(filePath)) throw new Error(`Missing generated evidence: ${filePath}`);
    if (readFileSync(filePath, "utf8") !== content) {
      throw new Error(`Generated evidence is stale: ${filePath}`);
    }
  }
}

function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.size !== 1 || (!["--write", "--check"].some((flag) => flags.has(flag)))) {
    throw new Error("Usage: node scripts/generate-pr45-disposition-manifest.mjs --write|--check");
  }
  const manifest = buildManifest();
  if (flags.has("--write")) writeEvidence(manifest);
  else checkEvidence(manifest);
  process.stdout.write(
    `PR #45 disposition evidence ${flags.has("--write") ? "written" : "verified"}: ` +
    `${manifest.totals.uniqueHistoricalPaths} historical paths, ${manifest.totals.hunks} hunks, ` +
    `${manifest.totals.unownedRows} unowned, ${manifest.totals.unknownDispositions} unknown\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
