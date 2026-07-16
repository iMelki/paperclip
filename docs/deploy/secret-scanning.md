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
and scans complete fetched history. Existing `verify` and `e2e` jobs depend on
that result, so the normal PR verification chain cannot pass after a scanner
finding or tool failure.

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
