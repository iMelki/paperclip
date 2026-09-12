# Failed-stop data-preservation correction

Issue33 / issue35; parent implementation on existing PR117 branch after
`e6c129dcb`. This is a bounded test-helper correction, not a native lifecycle fix.

## Observed defect and correction

The helper converts rejected stop to the fulfilled value `failed`, then uses
`finally(cleanupOnce)`. A settled failure therefore reclaims data. The replacement
only reclaims after a `stopped` outcome, returns false for unresolved cleanup,
and aborts startup retries with the original startup diagnostic and retained path.
Synchronous stop throws are normalized to the same failure outcome.

## Validation

Exact caller: `node scripts/run-vitest-stable.mjs --files packages/db/src/test-embedded-postgres-stop.test.ts`.
Six tests passed, exit0,432ms runner /10ms tests. Filesystem, socket, native
preparation and Windows reaper are mocked. No database or real deletion ran.

Deliberately changed the success predicate to permit `failed` and disabled the
no-retry guard. `rg` readback confirmed both changes before the same caller ran:
exit1, four attributable failures. Three asserted cleanup must not run after
rejection/late rejection; the fourth observed five retries instead of the
unresolved-cleanup error. Restored both exact predicates and reran: six pass.
Restored source SHA256:
`60942d38fe887622451ec45b3fb6783e6e97c723961ae8c2d68189321f61a1d7`.
This is a post-restoration hash, not an independently captured pre-break hash.

## Limits and maintainability

No proof that vendor stop success means this launch attempt's descendants exited.
Existing Windows forced-stop ownership logic is unchanged and remains a separate
hold. No persistent-cluster ownership, package integration or native/elevated
acceptance is claimed. Late success may reclaim, but retry already aborted.

Production file328->338 physical lines,269->278 nonblank/non-comment source
lines; stop function54->57 physical lines. Single predicate and
boolean result keep the existing control flow; no unrelated extraction. New
mock test file is under100 lines, six cases. Counts above exclude blank and
whole-line // comments; nonblank-only counts differ. Independent reviewer found
no blocking issue in this bounded delta, inspected source hash/tests/negative
receipt, and accepted retaining the cohesive stop sequence. Review did not run
tests; execution evidence is the parent's. Native/ownership holds remain.

Sources: [Promise finally semantics](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/finally),
[PostgreSQL pg_ctl wait semantics](https://www.postgresql.org/docs/18/app-pg-ctl.html).
The existing issue33 checkpoint identifies this source-review finding; the mocked
negative control now reproduces the callback error without risking real data.

## Normal-hook prerequisite failure

First normal commit attempt reached the outer300s bound, no commit produced.
Affected-package typecheck passed; six mocked tests passed inside the hook.
Its normal related selection then ran native backup tests:5pass/2fail. Failures
were `psql ENOENT` with fallback COPY syntax (existing issue40), and initdb exit
3221225794 (cause unproven). Therefore no-native-launch claims above apply only
to the focused mocks, not the normal hook. Log retained under
`.tmp/paperclip-pr117-publication-logs/commit-20260912T220315Z.log`.
Post-run observed PostgreSQL processes predated this attempt (2026-09-10);
their command lines were unreadable, so none was terminated.

Retry setup uses the already-installed PostgreSQL17 client directory only in
the publication child environment, not user/machine PATH. The existing12-suite
selection is unchanged; outer commit deadline extended to1800s with RAM80%
ceiling. This is prerequisite recovery, not a hook bypass or native acceptance.
