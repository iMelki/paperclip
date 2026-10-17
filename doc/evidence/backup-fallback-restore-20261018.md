# Private backup fallback restore qualification — 2026-10-18

## Outcome

The isolated JavaScript restore fallback now understands the default text
`COPY ... FROM stdin;` blocks emitted by Paperclip's own backup writer. It only
recognizes a COPY command at a statement boundary after blank/comment lines,
streams row data into postgres.js, preserves ordinary SQL after the `\.`
terminator, and fails closed on unsupported formats or an unterminated block.

No live Factory database, installed app, backup, credential, GitHub connection,
or agent task was modified or used by these source tests. The live installation
was not restarted or updated. The separate native-psql isolated restore remains
the proven recovery route for a future controlled rollout.

## Source and independent review

- Candidate repository: `iMelki/paperclip` local private worktree at
  `agent/codex/1620-private-project12-qualified-20261013`.
- Candidate base at start: `658ea0d63574071d0bd05ee54c08dd9653e2f57a`.
- Changed files: `packages/db/src/backup-lib.ts` and
  `packages/db/src/backup-lib.test.ts`.
- The independent Paperclip Codex Cloud review confirmed the API contract for
  the pinned postgres.js 3.4.9: await `.writable()`, then pipeline COPY input
  into the returned Writable. It also identified parser ambiguity, unsupported
  CSV/binary forms, marker-looking data, and object-mode buffering. The local
  change addresses those points for the generated default-text format.
- The Cloud checkout was a different clean commit (`b791094`) and did not have
  this candidate; its test result is review evidence, not a local candidate
  validation.

## Validation

- Full `packages/db/src/backup-lib.test.ts`: **9 passed, 0 failed, 0 skipped**.
  Task-owned run: `run-20261018T003000Z-backup-lib-suite-final`; terminal status
  `success`; duration 218,240 ms; peak Job memory 540.9 MiB; zero active
  processes proven; stdout/stderr captures complete, healthy, and dropped 0
  bytes.
- DB package TypeScript check (`tsc --noEmit -p packages/db/tsconfig.json`):
  exit 0; terminal task-owned run `run-20261018T003500Z-db-typecheck-final`;
  duration 25,632 ms; peak Job memory 1,004.8 MiB; zero active processes proven.
- `git diff --check`: run after the final documentation/source edits.
- Test receipts and complete logs are in the current user's private
  TaskOwnedJob namespace under task `paperclip-1620-copy-restore`; no raw DB
  payload or credentials are included in this report.

## Diagnostic attempts and fixes

- The first focused regression attempt used a 20-second test timeout, shorter
  than the measured Windows embedded-PostgreSQL startup and test duration. It
  failed at 20 seconds and produced a connection reset during synthetic-test
  cleanup; it did not touch the live instance.
- A later focused attempt showed the same fixture-level timeout. Increasing the
  isolated test's own timeout and encoding actual tab delimiters in COPY input
  resolved the fixture issue.
- During correction, review found that the destination returned by
  `postgres.js` `.writable()` must be awaited before calling `pipeline()`. The
  regression now exercises that exact API and passes.
- All synthetic database/temp fixtures were removed by the test suite's
  existing cleanup hook under the user's explicit fixture-cleanup approval.
  All TaskOwnedJob receipts/logs were retained; no existing user file was
  deleted.

## Remaining gates

- Source is locally qualified but is not installed, activated, pushed, or
  published. Public GitHub writes remain explicitly out of scope.
- The successful backup restore was isolated; this does not prove a live Factory
  restore or replace a verified production rollback rehearsal.
- GitHub OAuth final Authorize is still operator-only. Project #12 is not bound
  to MemSys, and no import/reimport or agent/provider dispatch occurred.
- Continue with the broader host/plugin validation and existing-owner same-app
  rollout only after all independent gates pass. Preserve current 5113 route and
  do not rerun import until authorization, dry-run/idempotency evidence, and the
  no-agent-dispatch guard are verified.
