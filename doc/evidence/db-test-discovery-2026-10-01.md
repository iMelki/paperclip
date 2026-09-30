# DB test discovery repair

Owner: [Paperclip #20](https://github.com/iMelki/paperclip/issues/20).
Base: `ed92fe5df7dbb30025a99aa8b0c61be3fda3fcc0`.
Date: 2026-10-01 local / 2026-09-30 UTC.

## Problem and scope

The DB TypeScript build includes `src`, so it emits test copies into `dist`.
The unmodified DB Vitest config used default discovery. A read-only file list
on the primary checkout found 26 authored `src` tests, one authored maintenance
test under `scripts`, and 27 compiled tests, including two stale dist-only suites.
This demonstrates duplicate discovery, not the cause of every Windows timeout.

The repair restricts discovery to `src` and `scripts`, preserves Vitest's default
file extensions and exclusions, and rejects nested `dist` paths. No test is
deleted. No timeout on an existing test is changed. No installed dependency,
live service, credential, database, or shared checkout is changed.

## Research and existing components

Reused `configDefaults` and the existing exact stable test runner. The current
[upstream DB config](https://github.com/paperclipai/paperclip/blob/master/packages/db/vitest.config.ts)
still uses the unrestricted defaults. The installed version is Vitest 4.1.10.
Its [version-pinned defaults](https://github.com/vitest-dev/vitest/blob/v4.1.10/packages/vitest/src/defaults.ts)
exclude node_modules and .git, not dist. Current
[include](https://vitest.dev/config/include) and
[exclude](https://vitest.dev/config/exclude) documentation describe explicit
source roots and retaining defaults. Older community issue examples that list
dist in defaults do not establish the behavior of this installed version.

## Attributable negative proof

Exact entrypoint:

```text
node scripts/run-vitest-stable.mjs --files packages/db/src/test-discovery.test.ts
```

- Old config: exit 1, two of three tests failed. Assertions named generated
  `dist/basic.test.js`, stale `dist/stale-only.spec.js`, and other non-authored
  paths. The authored maintenance filter passed.
- Repair: exit 0, three of three passed through the same exact entrypoint.
- Changed back: restored the config to the base text using a scoped edit;
  the identical exact entrypoint again exited 1 with the same two failures.
- Restored repair: the exact regression passed 3/3. A second exact call retained
  the real `scripts/clean-poisoned-claude-sessions.test.ts` suite, passing 15/15.
- Held constant: branch/base, installed Node 24.18 and Vitest 4.1.10,
  assertions and synthetic file inventory. Host load was not artificially fixed.
  No timing speedup or full-suite reliability claim is made.

The fixture files throw if executed. `list --filesOnly` reads discovery only;
it does not execute fixtures or start PostgreSQL. Child launches use argv,
windowless pipe capture, a 30-second bound, and a 40-second outer test bound.
Tiny synthetic fixtures are retained for inspection and governed recycle cleanup.

Private logs: `.local-logs/db-discovery/` in the isolated topic worktree.
Ledger: `db-authored-test-discovery` in `.gate-evidence.json`.

## Validation and remaining gates

The DB typecheck passed. Focused maintenance and regression tests passed with
zero skips. The regression is an ordinary DB source test, so root default,
grouped hosted DB tests, and exact changed-test selection use it; there is no
separate unconnected script gate.

The DB package build passed, including its migration checks and filesystem-copy
step. Root `vitest list packages/db --filesOnly --json` after that build found
27 authored src suites (including the new regression), one maintenance script,
and zero dist copies. The exact regression passed 3/3 again after build.
Normal commit/push gates, independent review and hosted CI are separate evidence.
Full workspace tests/build are not claimed by these focused results. The
surrounding #20 lifecycle/timeouts remain open.

## Factory and sync checkpoint

Read-only refresh at 2026-09-30 21:09 UTC found the Factory API unavailable on
5113 and 3100. The clean Factory checkout and launcher now both match `ed92fe5`;
the older pin mismatch is superseded. PR #133 remains draft/conflicting with a
failed review and CTO hold. No qualified private Node 24.21 or complete governed
archive/restore consumer exists. PG binaries report 18.6, but dump metadata is
not a restore proof. Recovery assets at agent-settings `0d9dd175` are published;
their synthetic refusal test does not prove full credential-safe recovery.

Plugin security PR #2 is merged. Plugin PR #5's import characterization remains
a test-only candidate. Persisted, fenced, company-scoped no-dispatch quarantine
must cover scheduled/manual/retry entrypoints before a real one-issue import.
Current SDK state get/set/delete is not a compare-and-set primitive. No sync,
restart, plugin installation, credential access, or merge was performed here.

Owners: Paperclip #125 recovery, #129 host, #126 import, agent-settings #1338
credential boundary. The plugin characterization gate is a separate parallel
topic work item. Broader repository sync and Projects permissions remain separate.
