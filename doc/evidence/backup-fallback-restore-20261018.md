# Private backup fallback restore qualification — 2026-10-18

> Status boundary: the COPY stream repair is committed and source-qualified.
> Its dependency tree has also been installed and checked in an isolated
> private source copy. It is **not installed in the live Paperclip app**.
> The live app continues to serve its prior commit; this report does not claim
> a rollout, OAuth approval, or GitHub Project #12 import.

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

## Late safety finding and response

Independent review found that the pinned postgres.js 3.4.9 can leave the
Writable final callback pending if PostgreSQL rejects COPY after the client has
sent CopyDone. The driver clears its stream reference when sending CopyDone and
normally settles the final callback only on CommandComplete. The public upstream
report [porsager/postgres#1173](https://github.com/porsager/postgres/issues/1173)
describes the same hang, skipped transaction rollback and pooled-connection
leak; it remains an upstream issue, not an accepted fix. PostgreSQL's
[protocol documentation](https://www.postgresql.org/docs/17/protocol-flow.html)
confirms that server-side COPY errors travel through ErrorResponse.

The candidate carries a narrow local postgres.js patch that settles the pending
Writable final callback with the server error, plus an isolated restore
regression that forces a COPY check-constraint rejection and verifies the
restore fails and its transaction leaves no table behind. The exact patch was
applied to a private copy of the pinned driver's verified upstream preimage;
the shared Factory dependency junction was never changed. The protocol suite
passed 4/4, the focused disposable-database rollback regression passed 1/1, and
the complete candidate `backup-lib.test.ts` suite passed 10/10 with the private
patched driver alias. This is source/test qualification only, not a dependency
install, activation, or live database change.

## Validation

- Earlier pre-driver-patch `packages/db/src/backup-lib.test.ts` run:
  **9 passed, 0 failed, 0 skipped**.
  Task-owned run: `run-20261018T003000Z-backup-lib-suite-final`; terminal status
  `success`; duration 218,240 ms; peak Job memory 540.9 MiB; zero active
  processes proven; stdout/stderr captures complete, healthy, and dropped 0
  bytes.
- DB package TypeScript check (`tsc --noEmit -p packages/db/tsconfig.json`):
  exit 0; terminal task-owned run `run-20261018T003500Z-db-typecheck-final`;
  duration 25,632 ms; peak Job memory 1,004.8 MiB; zero active processes proven.
- `git diff --cached --check` passes for all source, test, lockfile and
  documentation changes. The generated unified patch has seven required
  whitespace-only context lines; its Cloud-matched SHA-256 and successful
  application to the verified upstream preimage are recorded below.
- The new server-rejection regression and postgres.js patch passed: protocol
  run `run-20261018T232800Z-c4d90b` (4/4, 2.8 s, 209.6 MiB peak Job memory);
  focused disposable-database rollback run `run-20261018T233000Z-3fd934`
  (1/1, 35.5 s); full backup-library run `run-20261018T233500Z-3fd934`
  (10/10, 172.0 s, 512.5 MiB peak Job memory). All ended successfully with
  zero active Job processes; receipts and logs remain in the private
  TaskOwnedJob namespace.
- Patch SHA-256: `605139acddce44b16c6c69ad3a6a58740c703f3cc7f4004a511bcb80a2ae547c`;
  pnpm patch hash: `sogjkqi5atqemwbhpven6z3bki`. Private driver's normalized
  upstream preimage SHA-256: `ee3a218d9aa6a6f2887c1a19da50009335fe84c11a5431d5cab72d6bc528632f`.
- DB package TypeScript check (`tsc --noEmit -p packages/db/tsconfig.json`):
  terminal task-owned run `run-20261018T234000Z-3fd934`; success, exit 0,
  native duration 25,604 ms; complete capture and zero active Job processes
  proven. This is distinct from the earlier historical DB typecheck run.
- Correct task-owned receipt groups are `paperclip-129-copy-patch-protocol`,
  `paperclip-129-copy-patch-rollback-test`,
  `paperclip-129-copy-patch-backup-suite`, and
  `paperclip-129-copy-patch-typecheck`; the prior label
  `paperclip-1620-copy-restore` was incorrect for these four runs. Exact
  receipt/stdout/stderr paths and hashes are in the owner-only proof packet;
  no raw DB payload or credentials are included.

## Private dependency staging

- The candidate was exported from commit
  `549ee8dff38685604a1b63264fa1e0887d5e0f7d` into a private local copy. The
  candidate's `packages/db/node_modules/postgres` in the working checkout is a
  junction into the running Factory app's dependency tree, so pnpm was never
  run against that checkout.
- pnpm **9.15.4** completed an offline, frozen-lockfile installation in the
  isolated copy with lifecycle scripts disabled (`1,166` packages; `54.5 s`).
  A first staging attempt safely failed because pnpm 9 interpreted an external
  absolute `--modules-dir` as a workspace-relative path; it wrote only under
  its private scratch directory. The normal per-copy `node_modules` layout
  avoided that ambiguity.
- The install command completed, but its wrapper initially returned a failure
  because a post-install verifier incorrectly looked for `postgres` at the
  workspace root. A separate read-only, task-owned verifier passed after
  checking the actual `packages/db/node_modules/postgres` junction: version
  `3.4.9`, target inside the private stage, patched `src/connection.js` contains
  the final-callback repair, and the staged lockfile selects the exact recorded
  patch hash. The Factory dependency junction was not followed or changed.
- Expected warnings remain: lifecycle scripts were deliberately disabled, so
  optional SDK development-server bin shims referencing an unbuilt SDK `dist`
  were not created. This qualifies dependency staging only; it does not qualify
  a full build, install into the app, or live activation.
- The current live app still reports ready on local and Tailscale port `5113`
  at commit `e226c8045f923f42e5191da2727d3ef1fbbb157f`. That is a health check
  for the existing app, not evidence that this candidate is running.
- Later readback on 2026-10-17 23:40–23:42 UTC supersedes that earlier healthy
  observation: both 5113 listeners remained present, but local API health timed
  out after 8 s and tailnet API health after 12 s. The local Node listener was
  still a descendant of the recorded WindowlessProcessHost, not an independent
  instance. `service.json` still said `healthy`, but its last health timestamp
  was stale. The bounded read-only factory-status collector exceeded its 30 s
  owner deadline; its exact owned job was terminated and zero active members
  were verified. No restart was performed. This indicates an unresponsive
  existing process; cause is not established. RAM later sampled at 88.6%, after
  a brief 90.5% reading.

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
- The first private fixture setup failed because Windows PowerShell could not
  load `Microsoft.PowerShell.Security`; no test ran. Its ACL was then verified
  and restricted with `icacls`. The managed runner also rejected the `C:\nvm4w\nodejs`
  symlink; subsequent test runs used the verified physical Node 24.18.0 binary.
  No shared package link or live process was altered.
- All synthetic database/temp fixtures were removed by the test suite's
  existing cleanup hook under the user's explicit fixture-cleanup approval.
  All TaskOwnedJob receipts/logs were retained; no existing user file was
  deleted.

## Remaining gates

- Source and isolated dependency staging are locally qualified, but the repair
  is not installed or activated in the live app. Public GitHub writes remain
  explicitly out of scope. The candidate's live dependency points through a
  junction into Factory; safe rollout therefore needs an isolated installed
  package/runtime and a separately controlled owner handover, not a pnpm run
  against the shared junction.
- The existing live process is currently unresponsive despite retaining its
  5113 listeners. Treat the stale service `healthy` field as invalid until an
  owner-bound live health check passes again. Restart/repair was not attempted
  in this evidence pass.
- The successful backup restore was isolated; this does not prove a live Factory
  restore or replace a verified production rollback rehearsal.
- GitHub OAuth final Authorize is still operator-only. Project #12 is not bound
  to MemSys, and no import/reimport or agent/provider dispatch occurred.
- Continue with the broader host/plugin validation and existing-owner same-app
  rollout only after all independent gates pass. Preserve current 5113 route and
  do not rerun import until authorization, dry-run/idempotency evidence, and the
  no-agent-dispatch guard are verified.
