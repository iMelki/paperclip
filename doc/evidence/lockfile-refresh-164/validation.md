# Issue 164 validation

The exact base SHA and source-file hashes are recorded in `receipt.json`.
The source branch is `agent/codex/164-lockfile-refresh-dev`, based on fork
`origin/dev`. The PR head and stable patch ID are recorded in the lane handoff.

## Results (2026-10-08 UTC)

| Command | Result |
| --- | --- |
| `node --test scripts/refresh-lockfile.test.mjs .github/scripts/tests/check-pr-lockfile.test.mjs` | 21 passed, 0 failed, 0 skipped; 2.80 seconds. |
| `node --test --test-reporter=tap scripts/refresh-lockfile.test.mjs .github/scripts/tests/check-pr-lockfile.test.mjs .github/scripts/tests/run-quality-gates.test.mjs scripts/check-pr-workflow-trigger.test.mjs` | 37 passed, 0 failed, 0 skipped; full output in `final-focused.log`. |
| `node --test .github/scripts/tests/*.test.mjs` | 156 passed, 0 failed, 0 skipped; 0.57 seconds. |
| `node scripts/check-pr-workflow-trigger.mjs` | Exit 0: master/dev PR coverage, no push event. |
| `actionlint .github/workflows/refresh-lockfile.yml .github/workflows/pr.yml` | Exit 0, no diagnostics; actionlint 1.7.8. |
| `act workflow_dispatch --list -W .github/workflows/refresh-lockfile.yml --input ref=dev --input base=dev` | Exit 0; refresh job listed. No usable Docker connection, so this is plan discovery only. |
| `git diff --check` | Exit 0. |
| `pnpm -r typecheck` | Exit 1: fresh clone lacks workspace dependencies (`ERR_MODULE_NOT_FOUND`). |
| `pnpm test:run` | Exit 1 before tests: fresh clone lacks `cli/node_modules/tsx`. |
| `pnpm build` | Exit 1 before build: fresh clone lacks `cli/node_modules/tsx`. |

The lane did not install the application dependency tree. Typecheck, application
tests and build remain unproven. No Skills were changed, so the skill scanner and
asset-version Pester suite do not apply. The clone has no configured
`core.hooksPath`; its hook directory contains sample files only. Commit/push use
the normal Git commands without bypass flags.

Before the full commands, host counters showed 9,695 MB available and commit
charge 74.23%. Both were within the lane's 92% limits. Test TEMP/TMP/TMPDIR used
a fresh lane-owned scratch folder. No process or service was stopped. No files
were deleted. Raw application-command logs remain in the private scratch folder.

## Negative proofs

All breaks were verified to apply. Each candidate file was restored in `finally`
and verified byte-identical by SHA-256. The commands and hashes are in
`receipt.json`; full outputs are alongside it and linked from `.gate-evidence.json`.

- Original workflow from `origin/dev`: 7 failures, 14 controls passed. Restored:
  21 passed. The tests caught missing manual routing, shared refresh branches,
  wrong PR selection and dev auto-merge.
- Original lockfile checker: 3 per-base acceptance failures, 8 controls passed.
  Restored: 11 passed.
- Checker widened to allow any author and refresh prefix: 4 rejection failures,
  7 controls passed. Restored: 11 passed. Wrong base, extra suffix, missing base
  and non-bot author were wrongly accepted by the mutant.
- PR policy with its new bot-author condition replaced by `true`: 1 failure,
  9 controls passed. Restored: 10 passed. A non-bot dev refresh branch was wrongly
  exempted by the mutant.

The tests execute the real workflow shell with intercepted Git writes/GitHub
calls. The original owner jq expression runs through real jq. Branch validation
runs real `git check-ref-format`. YAML expressions and both review predicates
are checked locally. No pnpm regeneration or live GitHub Actions dispatch occurred.

## Remaining proof and owner

The acting CTO owns independent review and the merge-freeze decision. After the
fix merges, the maintainer owns a dispatch using the dev workflow and readback
of its run ID and saved PR. Use [the dispatch guide](../../LOCKFILE_REFRESH.md).
Issue [164](https://github.com/iMelki/paperclip/issues/164) stays open pending that
handoff. PR [165](https://github.com/iMelki/paperclip/pull/165) still needs its
patch-aware lockfile refresh and its separately reported Windows test result.
