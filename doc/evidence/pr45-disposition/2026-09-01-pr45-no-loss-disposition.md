# PR #45 No-Loss Disposition Evidence

This evidence turns the four preserved PR #45 commits into a finite, machine-checkable census. It does **not** authorize a merge, cherry-pick, branch deletion, stash mutation, or evidence retirement.

- Owner: [Paperclip #80](https://github.com/iMelki/paperclip/issues/80)
- Comparison commit: `f8e718e4a4ae5bae9fb570aff59b56c89fe1a715`
- Preserved source ref: `wip/coordination-engine-20260802` at `7bae4af253dfd96ac8a4d44807b479bcece01865` (local and remote-tracking refs match)
- Commit-path rows: 162
- Unique historical paths across the four commits: 131
- Net paths in the final PR diff: 130
- Unified-zero hunks: 3032
- Declared merge-conflict paths: 4
- Unowned rows: 0
- Unknown dispositions: 0

## Commit Census

| Commit | Evidence mode | Paths | Hunks | Conflict paths | Hunk dispositions |
| --- | --- | ---: | ---: | ---: | --- |
| `36ba7d08` | first-parent-unified-zero | 107 | 1008 | 0 | selective-extraction candidate: 916; semantically rederive: 80; landed-with-evidence: 12 |
| `5cba7569` | first-parent-unified-zero | 5 | 20 | 0 | selective-extraction candidate: 20 |
| `0f23e79a` | first-parent-unified-zero | 2 | 4 | 0 | semantically rederive: 4 |
| `7bae4af2` | remerge-diff-unified-zero | 48 | 2000 | 4 | semantically rederive: 2000 |

## What Is Still Open

- **selective-extraction candidate:** 936 hunks remain owned extraction or redesign work.
- **semantically rederive:** 2084 hunks remain owned extraction or redesign work.

A `selective-extraction candidate` is preserved source material that still needs narrow current-`dev` review. A `semantically rederive` row carries useful intent but must be redesigned against current contracts rather than copied. `landed-with-evidence` requires the exact hunk result in both a named merged PR commit and the pinned comparison tree. Every remerge-diff hunk is conservatively `semantically rederive`: Git's reconstructed-merge comparison can contain meaningful manual conflict resolution, so none is declared stale without path-specific proof.

## Hard Safety Boundary

- wholesale merge is forbidden.
- wholesale cherry-pick is forbidden.
- source-branch deletion is forbidden without separate explicit approval.
- stash mutation is forbidden.
- preservation-checkout or evidence retirement is forbidden.

## Reproduce

- Write: `node scripts/generate-pr45-disposition-manifest.mjs --write`
- Check: `node scripts/generate-pr45-disposition-manifest.mjs --check`
