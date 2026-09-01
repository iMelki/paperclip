import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManifest,
  classifyPath,
  parseUnifiedZeroPatch,
  validateManifest,
} from "./generate-pr45-disposition-manifest.mjs";

test("unified-zero parser preserves path, hunk header, and patch identity", () => {
  const parsed = parseUnifiedZeroPatch(
    [
      "diff --git a/example.ts b/example.ts",
      "index 111111111..222222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, "example.ts");
  assert.equal(parsed[0].hunks.length, 1);
  assert.equal(parsed[0].hunks[0].header, "@@ -1 +1 @@");
  assert.match(parsed[0].hunks[0].patchSha256, /^[0-9a-f]{64}$/);
});

test("path ownership is explicit and remerge material always requires semantic review", () => {
  const portability = classifyPath("packages/adapter-utils/src/shell-path.ts");
  assert.equal(portability.ownerCluster, "adapter-shell-path-and-workspace-portability");
  assert.ok(portability.ownerIssues.some((issue) => issue.number === 47));
  const merge = classifyPath("unrecognized/merge-only.txt", { mergeArtifact: true });
  assert.equal(merge.disposition, "semantically rederive");
  assert.equal(merge.ownerCluster, "pr45-merge-resolution-manual-review");
  assert.throws(() => classifyPath("unrecognized/non-merge.txt"), /No owner cluster/);
});

test("the preserved object census is complete, owned, and has no unknown dispositions", () => {
  const manifest = buildManifest();
  assert.equal(validateManifest(manifest), true);
  assert.equal(manifest.totals.commitPathRows, 162);
  assert.equal(manifest.totals.uniqueHistoricalPaths, 131);
  assert.equal(manifest.totals.netPullRequestPaths, 130);
  assert.equal(manifest.totals.hunks, 3032);
  assert.equal(manifest.totals.conflictPaths, 4);
  assert.equal(manifest.totals.unownedRows, 0);
  assert.equal(manifest.totals.unknownDispositions, 0);
  assert.equal(manifest.preservationRef.localHead, manifest.preservationRef.expectedHead);
  assert.equal(manifest.preservationRef.remoteTrackingHead, manifest.preservationRef.expectedHead);

  const remergeCommit = manifest.commits.find(
    (commit) => commit.evidenceMode === "remerge-diff-unified-zero",
  );
  assert.ok(remergeCommit);
  assert.equal(remergeCommit.totals.hunks, 2000);
  assert.equal(remergeCommit.totals.conflictPaths, 4);
  assert.ok(
    remergeCommit.paths
      .flatMap((entry) => entry.hunks)
      .every((hunk) => hunk.disposition === "semantically rederive" && hunk.evidence === null),
  );

  const landedEvidence = manifest.commits
    .flatMap((commit) => commit.paths)
    .flatMap((entry) => entry.hunks)
    .map((hunk) => hunk.evidence)
    .filter(Boolean);
  assert.equal(landedEvidence.length, 12);
  assert.deepEqual(manifest.totals.dispositions, {
    "selective-extraction candidate": 936,
    "semantically rederive": 2084,
    "landed-with-evidence": 12,
  });
  for (const evidence of landedEvidence) {
    assert.equal(evidence.kind, "exact-hunk-change-in-named-commit-and-identical-current-blob");
    assert.equal(evidence.landedBlob, evidence.comparisonBlob);
    assert.match(evidence.landedCommitFirstParent, /^[0-9a-f]{40}$/);
  }
});
