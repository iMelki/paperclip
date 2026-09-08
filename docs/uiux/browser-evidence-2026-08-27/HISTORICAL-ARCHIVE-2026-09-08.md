# Historical browser evidence archive — 2026-09-08

This note preserves the provenance of earlier 2026-08-27 gauntlet attempts.
It does not assert present UI health, raise a score, close an issue, or
authorize a browser run, agent heartbeat, restart or other runtime action.

Reviewed stash: `9b64903d6cb22e0d75e816691d3d40f1d6e0f835`.
Its base was `f7a0160fc62933fe6d9608b03f29c6b161495de0`; the index parent
`c38f05b119d67c08607c3454f6de7506ca545454` contains no staged changes. The untracked
parent was `77153c2a8407e246bc6f3e424efab44a7e735087`.
Comparison target: origin/dev `32bf0cc804d2d7c42adb3d763136a21571101698`.

## Retained intent

The stash has **18 payload files, 646,302 bytes**: five changed
tracked files and 13 untracked files. It contains no changed executable source.

- `SCORECARD.md`, `gauntlet.json`, and `gauntlet-run10-f7a0160fc.json` are exact
  current origin blobs. Their historical score and limitations remain in Git.
- Seven screenshots are distinct historical variants: three share names with
  currently tracked images and four were previously untracked. Their old
  bytes are archived; none replaces a current image.
- Four receipts from runs 2, 7, 8 and 9 and four accompanying run logs record
  earlier attempts, including the unsettled/cold-chunk observations already
  summarized by [SCORECARD.md](SCORECARD.md). Their states are historical,
  not current machine receipts. A repeated log blob still retains both names.

The complete method/score relationship stays anchored to the dated scorecard
and the current named run-10 receipt. This archive does not reopen or close
the broader work referenced there:
[#48](https://github.com/iMelki/paperclip/issues/48),
[#94](https://github.com/iMelki/paperclip/issues/94), and
[#89](https://github.com/iMelki/paperclip/issues/89).

## Private preservation

Workspace-relative archive location (outside this repository):
`Assistants/.tmp/fleet-git-hygiene-20260908/paperclip-factory-stash-reconciliation/stash-payloads.zip`.

- Archive SHA-256: `c1d013abb4dd6d5c11dadbaacd350d8158d827beabe013de6dbe6f51f0c31e92`.
- Per-file provenance: adjacent `manifest.json`, SHA-256
  `0ba6c7614302d4ca60d3fff3d15a7d1084c991c520f9460b1f60103f7da3ca6d`. It records original paths, layers,
  modes, Git blob IDs, bytes, SHA-256 and comparison with origin.
- All 18 entries were written and reopened in 64-KiB chunks; every size and
  SHA-256 matched. Screenshots and raw logs remain private, not bulk-published.

Keep this archive and manifest under **Preserve; no bulk cleanup** until at
least 2026-10-08 and longer while a linked review requires them. That is an
earliest review date, not automatic deletion. If relocated, stream-verify the
copy and update this pointer before retiring the old location. Restore into a
separate review directory; never replay archived images or receipts onto
current paths as part of cleanup.

The repo's [artifact workflow](../../../doc/AGENT-ARTIFACTS.md) distinguishes
board-uploaded deliverables from workspace-only work products. This cleanup
sidecar was expressly local/artifact-only: no Paperclip attachment or work
product was created. If these raw artifacts later become a board deliverable,
review their contents/privacy and follow that workflow under the owning task.
The current repository's tracked evidence remains tracked.

Once this summary/pointer is committed and the verified external archive is
retained, the exact reviewed stash can be retired without losing source intent
or historical evidence. No current files, stash refs or live state were changed
by the evidence review itself.
