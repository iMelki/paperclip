# Claude ACP session quota recovery

Related tracker: [#162](https://github.com/iMelki/paperclip/issues/162).
This is a bounded follow-up to the provider-failure recovery work. It does not
claim to complete the tracker or its other approved slices.

## Problem and change

A Claude ACP failure can have error code `acpx_turn_failed` and message
`You've hit your session limit` followed by a `resets` clock. Recovery previously
accepted neither that error code nor that quota wording. It therefore missed
the existing provider-quota wait path.

The classifier now accepts this adapter error code, recognizes Claude's own
`You've hit your session limit` statement, and parses both `resets` and `resets at`. It uses the existing timezone parser,
one-hour fallback, and provider-quota recovery monitor. This change adds no
scheduler, provider route, credential behavior, or paid fallback.

## Local evidence

Base source: `e226c8045f923f42e5191da2727d3ef1fbbb157f`.
Evidence date: 2026-10-13. Caller: Codex. Mutation intent: isolated source only.

Focused command, from `server`:
`node ../node_modules/vitest/vitest.mjs run src/services/recovery/provider-failure-classification.test.ts --maxWorkers=1`.

| Check | Result | Exit | Duration |
| --- | --- | --- | --- |
| New fixtures against the unchanged classifier | 4 failed, 11 passed | 1 | 25.84 s |
| Fixtures after the classifier change | 15 passed | 0 | 66.08 s |
| Server TypeScript check | Passed | 0 | See local receipt |
| Generic `session limit` ACP controls (3) against the first fix | 3 failed, 15 passed | 1 | 10.9 s |
| Fixtures after narrowing session-limit wording | 18 passed | 0 | 10.9 s |

Review follow-up: bare `session limit`, `session limit reached` and
`session limit exceeded` also occur in unrelated tool, MCP and terminal
failures. Only the provider statement `You've hit your session limit`, as
Claude Code prints it (`You've hit your session limit · resets 1:50am
(Asia/Tokyo)`), now counts as quota evidence. Three generic ACP controls
containing that phrase stay out of quota recovery.

Implementation commit: `4e3bdfd0`. The unmodified repository pre-commit hook
passed server and dependent CLI typechecks, 12 selected regression suites
(142 tests), forbidden-token checks, and the pinned Gitleaks staged scan.
The repository's normal related-suite cap selected 12 of 165 importing suites;
this is bounded local qualification, not an exhaustive hosted-CI result.
The backend change does not require React validation. The hook separately
reported React Doctor incomplete because its exact dependency is not pinned.

The negative run occurred before editing the classifier. Its four failures
were missed quota classifications, not unrelated setup failures. The positive
run also covers ordinary ACP errors, non-adapter failures, paused issues,
existing usage-limit messages, missing clocks, and configuration failures.

The reset fixture maps 10:40pm in Asia/Jerusalem to 19:40 UTC on 2026-10-13.
The tests use generic fixtures without instance-local task or agent identifiers.
Initial focused checks used the base checkout's installed dependencies; normal
repository hook checks use an offline, frozen-lockfile installation in the
isolated candidate checkout. No live dependency tree was relinked.

## Delivery and recovery conditions

Local test success is source proof. Publication, independent review, installed
adoption, and native recovery proof remain separate conditions.

The runtime owner must install the reviewed candidate through the normal
deployment process. Preserve deliberately paused or cancelled work, ownership
changes, approval gates, and task admission requirements. The change does not
authorize a service restart, model substitution, paid overflow, or a new login.

After installation, use one admitted native quota failure to verify that the
saved recovery record contains the provider-quota reason and future monitor,
that no immediate retry is issued, and that any post-reset attempt has an
actual recorded outcome. Preserve blocker state when the provider remains
unavailable. Blocked issues without an admissible execution path require their
accountable recovery owner; do not change their status merely to schedule a
monitor.
