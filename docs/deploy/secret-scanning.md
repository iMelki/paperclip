---
title: Secret scanning
description: Pinned local and pull-request Gitleaks enforcement for Paperclip contributors.
---

Paperclip uses Gitleaks `8.30.1` for staged local changes and complete Git
history in pull requests. A missing binary, a different version, a scanner
runtime error, or a finding all fail closed.

## Local commits

Install the official Gitleaks `8.30.1` binary and make it available as
`gitleaks` on `PATH`, or set `PAPERCLIP_GITLEAKS_BIN` to its absolute path.
The Husky pre-commit hook runs:

```bash
node scripts/verify-gitleaks.mjs --staged
```

The wrapper uses Gitleaks' current `git --pre-commit --staged` command and
redacts findings from terminal output. Exit `2` means a finding; exit `3`
means the pinned binary or scanner runtime failed. Both block the commit.

## Pull requests

The `secret-scan` job in `.github/workflows/pr.yml` downloads the official
Linux x64 `8.30.1` release, verifies SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`,
and scans only the pull request's commit range (`base..head`, by exact SHA) with
`node scripts/verify-gitleaks.mjs --range`. A real-scanner test in the same job
proves that an in-range secret fails, an out-of-range one is skipped, and a range
whose commits are missing fails closed. The range scan passes `--diff-merges=remerge` to
`git log`, so a secret that exists only in a merge commit's own diff (a conflict
resolution) is caught without re-reporting reviewed content under merge SHAs (a
real-scanner test builds such a merge). Existing `verify` and `e2e` jobs depend on
that result, so the normal PR verification chain cannot pass after a scanner
finding or tool failure.

`pr.yml` does not run when only the base branch changes. The separate
`secret-scan-retarget` job in `.github/workflows/pr-retarget-secret-scan.yml`
re-scans the current `base..head` range on every PR edit (so a retarget is
covered); it has its own concurrency group so it never cancels the main PR checks.
It runs only on edit events, so a PR that was never edited has no
`secret-scan-retarget` check; do not make it a required check in branch
protection, or every unedited PR would wait for it forever. Read it as an
advisory result next to `secret-scan`.

`--diff-merges=remerge` does not apply to octopus merges (three or more parents),
so a secret added only by the conflict resolution of an octopus merge is not
scanned. The repository history has none today; if one appears in a PR range,
review it by hand.

The range scan does not cover commits that never pass through a pull request:
direct pushes and upstream-sync commits. Run `node scripts/verify-gitleaks.mjs
--history` on a GitHub-hosted runner for those until a scheduled full-history
scan exists (not part of this change).

## Historical fixture review

The repository had 18 repeated historical detections across synthetic secret
service/JWT tests, generated Storybook bundles, and one deployment example.
`.gitleaksignore` records only their exact Gitleaks fingerprints. Do not replace
those entries with path, rule, commit, or regex-wide exclusions. New values,
locations, and commits must remain detectable.

Treat any new finding as real until reviewed. Rotate a live credential before
changing code or ignore policy. Add an exact fingerprint only when the value
is demonstrably synthetic and the review is recorded in
[`iMelki/paperclip#13`](https://github.com/iMelki/paperclip/issues/13).
