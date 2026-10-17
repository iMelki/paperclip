# Paperclip Open Tasks

> GitHub issues are the authoritative tracker. This file is a convenience index and can lag behind GitHub.

## Current private installation repair — 2026-10-15

**2026-10-16 current correction:** the existing old GitHub plugin is disabled,
not ready. All thirteen module bindings, full strict plugin typecheck, real-data
restore checks and protected launcher rollback copies are now verified. Do not
replay them. Installation is held on two newly confirmed host defects: disabled
deferred upgrade is rejected and added capabilities cannot reach pending
approval. Root owns the focused source repair; Chief owns bounded native tests;
CTO owns the same-instance installation. See
[private upgrade repair and acceptance](doc/evidence/plugin-upgrade-approval-20261016.md).
The focused host repair is now source-reviewed, 44/44 regression-qualified and
production-typechecked (55.103 s, no diagnostics). Commit and installation remain
pending; the running app is still the unchanged previous version. Do not replay
the plugin build, dependency work or closed host tests for the private commit.
Final GitHub Authorize, exact Project #12 mapping and two actual bounded imports
remain pending; no public write or live outcome is claimed.

**2026-10-18 source correction:** isolated recovery review exposed a separate
JavaScript-backup restore defect: the fallback treated PostgreSQL `COPY FROM
stdin` rows as executable SQL. The private candidate now streams only the
one-line default-text COPY form emitted by Paperclip's own backup writer, treats
marker-looking rows as data, and rejects unsupported or unterminated COPY
blocks. The complete `backup-lib.test.ts` suite passed 9/9 and the DB package
TypeScript check passed. A later independent review found the pinned postgres.js
3.4.9 can hang a COPY pipeline on a server-side row rejection after CopyDone
(upstream porsager/postgres#1173). The narrow driver patch passed all four
synthetic protocol cases, its disposable-PostgreSQL rollback regression, and
the full `backup-lib.test.ts` suite (10/10) using a private patched dependency
copy. It is source-qualified; the candidate dependency tree and live instance
remain unchanged. A separate offline pnpm 9.15.4 install completed in a private
git-archive copy with scripts disabled; a task-owned readback verified postgres
3.4.9 resolved to the private patched tree. SDK development-bin warnings are
expected from the script-disabled install stage. A subsequent bounded build of
the exact paired `@paperclipai/shared` 0.3.1 and `@paperclipai/plugin-sdk` 1.0.0
completed both TypeScript compilation steps; all 19 SDK export/type/bin targets
exist, and a runtime smoke loaded its main, protocol and UI entries. This
qualifies the isolated SDK build/runtime surface only, not a whole-app build,
live installation, or rollback. No live Factory restore, app restart, plugin
installation, GitHub authorization, Project #12 binding/import, or agent dispatch
occurred. The earlier exact native-psql isolated restore remains the proven
recovery path for rollout. See the [private validation receipt](doc/evidence/backup-fallback-restore-20261018.md).

**2026-10-18 runtime regression observed:** ports 5113 still have listeners,
but local health timed out at 8 s and tailnet health at 12 s without response.
The app's Node listener is still descended from its recorded windowless service
host, so this is not yet evidence of a second independent Paperclip instance.
`service.json` still says healthy, but its last health timestamp is stale; the
bounded read-only status collector itself hit its 30 s limit and its owned job
was verified closed. No restart or install was attempted. RAM sampled at
88.6% after one transient 90.5% reading. Investigate the responsive-owner/log
stall before any controlled repair; do not trust the stale healthy flag.

**Read-only recovery follow-up (2026-10-17 23:45–23:46 UTC):** without a
restart, local and tailnet `/api/health` both returned 200 for the unchanged
`e226c804` app; `/ASI/projects` also returned 200 on both routes. Local route
latency was about 6 s while tailnet varied from 0.45–5 s. The transient stall
recovered, but its cause is unknown and the stored manager health stamp remains
stale. The exact owner ancestry, endpoint timings, status-probe timeout, and
authoritative log hashes are retained in the private runtime readback. Do not
claim the COPY candidate is installed.

**Dependency rollout gate:** the source-checkout install instructions are
`pnpm install` then `pnpm dev`; the managed npm `update --rollback` does not
apply to this Factory dev service. The candidate's postgres junction points
into Factory's shared `node_modules`, and no complete Factory dependency
rollback image exists. The project-supported install was qualified only in
the private archive copy; do not run it from the candidate checkout until an
isolated install destination and full hash-verified rollback package are ready.

**2026-10-18 runtime regression observed:** ports 5113 still have listeners,
but local health timed out at 8 s and tailnet health at 12 s without response.
The app's Node listener is still descended from its recorded windowless service
host, so this is not yet evidence of a second independent Paperclip instance.
`service.json` still says healthy, but its last health timestamp is stale; the
bounded read-only status collector itself hit its 30 s limit and its owned job
was verified closed. No restart or install was attempted. RAM sampled at
88.6% after one transient 90.5% reading. Investigate the responsive-owner/log
stall before any controlled repair; do not trust the stale healthy flag.

**Read-only recovery follow-up (2026-10-17 23:45–23:46 UTC):** without a
restart, local and tailnet `/api/health` both returned 200 for the unchanged
`e226c804` app; `/ASI/projects` also returned 200 on both routes. Local route
latency was about 6 s while tailnet varied from 0.45–5 s. The transient stall
recovered, but its cause is unknown and the stored manager health stamp remains
stale. The exact owner ancestry, endpoint timings, status-probe timeout, and
authoritative log hashes are retained in the private runtime readback. Do not
claim the COPY candidate is installed.

- **Private Agent Settings #1620 / Paperclip #129 — activation disk-manifest
  refresh guard:** pre-existing refresh can replace the registry manifest from
  disk without added-capability approval. The current CAS repair does not close
  that separate path. Retain exact artifact hashes and sole-writer custody,
  refuse drift before separately approved Enable, and qualify the general
  same-capability-refresh/added-capability-denial repair as follow-up. See the
  limitation in the private upgrade evidence document above; no broad activation
  readiness or live exploitation is claimed.

Paperclip #129/#126 and Agent Settings #1620: actual reviewed service successor
passed mock24/24, native board20/20, selected routes17/17 and new server noEmit
exit0/23.977s. All owned native Jobs reached zero with complete healthy streams.
Six additional validation-only routes now actually pass6/6, exit0/13.130s; Root
independently read exact named assertions and native receipts. Current focused68
passes include one synthetic backup/two-restore test and23 distinct of30 route
cases, NOT whole-file30. Seven fixture/symlink/
npm paths remain separately gated, not silently skipped as accepted.

Original PostgreSQL startup-pipe blocker is fixed in the candidate: exact direct
PID/data/port readiness and clean owned shutdown/drain actually passed. Source
seal4f22b8fc and independent review212eb78f bind helper672703c4/test41b9b1bd.
Root independently verified selected assertion names, native receipts, bytes and
unchanged source. Earlier lifecycle11/UI proof stays exact-body lineage only.

Installed GitHub Sync is still0.8.12 ready; new board repair is NOT installed,
authorized, bound or imported. Existing MemSys stays open on HTTPS5113. Original
Chief owns read-only managed status/Git readiness and native execution. Retained
PG18 client provenance and three actual18.6 version probes passed; the synthetic
archive restored twice with owned shutdown. Real Factory backup/restore remains open.
CTO selected a fixed reviewed private Git generation, not new immutable packaging.
Its reviewed R5 selector/dependency-check has45 authored cases, unrun/not adopted.
Actual managed status and required UI token gates passed. Running-host ownership
still reports unproven; original owner investigates before any replacement.
Ordinary Git discovery/full diff/diff-check passed; private checkpoint is pending.
Keep changes local: both target repos are public, and direct human keep-private
instruction means NO public push/PR/comment/issue. Local normal-hook commit is
separate and pending complete reviewed diff/hook/privacy checks. Final Authorize
is human-only. No app stop or live provider/GitHub run in this source phase.
See [actual checks, rollback, acceptance and remaining Next15](doc/evidence/plugin-deferred-activation-20261015.md).

## Historical private integration status — 2026-10-14 local

Same Paperclip app is healthy on desktop and tailnet5113; Project12 is not installed,
authorized or imported. The51-case dependency source suite now passed with explicit
TAP and independent durable-log readback. The actual plan next refused Better Auth's
React peer range; pinned pnpm root-peer override preprocessing was missing.
Closure19's18 and peer-override24 controls passed. Full19 plan45A4/apply744D and
all205 actual bindings are independently accepted. SharedBuildE617(816 outputs)
and SDK575776(68 outputs/original config) passed and were independently accepted.
Server/UI actual typechecks each found one error; reviewed narrow repairs changed
only2/3456 source rows. Exact transition7889/caller95D source/controls passed, but
repaired rerun03:07 refused own98.621275% RAM before child. No repaired typecheck
pass/install/Authorize/live import. Chat/ongoing work untouched; no process stops.
Recovery, full closure, hooks and installation remain open. Start at the
[current checkpoint](doc/evidence/project12-qualification-delta-20261013.md#source42-passed--2026-10-14).
Older dated queues and receipts below remain history; do not reuse them as current
candidate/install/live acceptance. The current checkpoint owns the integration Next15.

## Next 15 Focus Queue

Refreshed 2026-09-28 against GitHub. The first four rows support the current GitHub
integration outcome; later rows remain queued and do not imply concurrent execution.

1. [paperclip#129 - Modernize Factory host for GitHub integration](https://github.com/iMelki/paperclip/issues/129): Resolve the isolated upstream merge, preserve deployed migrations, and qualify recovery before replacing the live host.
2. [paperclip#126 - Qualify the GitHub issue import pilot](https://github.com/iMelki/paperclip/issues/126): Prove one allowlisted repository imports without GitHub writes or agent dispatch and repeats without duplicate issues.
3. [paperclip#130 - Finish Windows plugin harness qualification](https://github.com/iMelki/paperclip/issues/130): Use the merged shell-free launcher and portable policy test to validate the secured plugin on the target host.
4. [paperclip#56 - Normalize Vitest scratch roots and prove abnormal-exit cleanup](https://github.com/iMelki/paperclip/issues/56): Give each stable test run one owned scratch root for TEMP, TMP, and TMPDIR, and remove only that root after normal and abnormal exits without a broad sweeper.
5. [paperclip#118 - Assess embedded PostgreSQL version exposure](https://github.com/iMelki/paperclip/issues/118): Select and qualify a patched database supplier while preserving compatibility and an independently verified restore path.
6. [paperclip#35 - Prove Windows embedded database lifecycle](https://github.com/iMelki/paperclip/issues/35): Exercise native startup and shutdown ownership on disposable data without treating mocked tests as runtime proof.
7. [paperclip#33 - Stop fixture process and disk leaks](https://github.com/iMelki/paperclip/issues/33): Prove shutdown before reclaiming fixture data so failed test runs leave recoverable evidence instead of orphan processes.
8. [paperclip#121 - Reconcile trusted review workflow authority](https://github.com/iMelki/paperclip/issues/121): Align the workflow and script sources used for trusted fork reviews while keeping untrusted code outside privileged execution.
9. [paperclip#41 - Retain ambiguous adapter launch evidence](https://github.com/iMelki/paperclip/issues/41): Preserve callback-bridge launch uncertainty through cleanup so the host cannot report unproven process termination as success.
10. [paperclip#29 - Harden task coordination leases](https://github.com/iMelki/paperclip/issues/29): Secure credential storage and prove idempotent claims before coordination leases authorize shared execution.
11. [paperclip#28 - Implement live task coordination authority](https://github.com/iMelki/paperclip/issues/28): Bind host, agent, task, and mutation ownership to authoritative records before enabling wider agent coordination.
12. [paperclip#30 - Bind quality verdicts to source identity](https://github.com/iMelki/paperclip/issues/30): Attach quality evidence to exact work units and revisions so stale or unrelated checks cannot authorize delivery.
13. [paperclip#94 - Repair browser-verified accessibility defects](https://github.com/iMelki/paperclip/issues/94): Address the remaining motion, typography, contrast, target-size, landmark, and route findings with fresh browser evidence.
14. [paperclip#89 - Fix narrow-screen layout overflow](https://github.com/iMelki/paperclip/issues/89): Verify dashboard, member tables, and profile flows fit the 390px viewport without horizontal content escape.
15. [paperclip#20 - Reap Windows test process trees and remove load-order timeout flakes](https://github.com/iMelki/paperclip/issues/20): Stop leaked test servers and embedded-database child processes so later suites stay within their time limits, then prove a full stable run leaves no new orphans.

## Current work

- [Embedded PostgreSQL reuse identity - upstream #6597](https://github.com/paperclipai/paperclip/issues/6597):
  Server startup now verifies PostgreSQL's data directory on the PID file's
  recorded port before reuse. The regression fails against the original server
  entry point and passes after restoration. Unit, native Windows, and startup
  checks cover recycled, live, and dead PIDs. Independent co-CTO review and
  deployment readback remain open. Migration, CLI worktree, and routine consumers
  retain their separate lifecycle checks; the broader shared approach is tracked
  in [upstream PR #9769](https://github.com/paperclipai/paperclip/pull/9769).

- [#162 — Recognize Claude ACP session quota waits](https://github.com/iMelki/paperclip/issues/162):
  The local candidate recognizes Claude's session-limit statement with
  `acpx_turn_failed` and parses its reset clock through the existing quota
  recovery path. Generic `session limit` wording stays out of quota recovery.
  The ACP statement is read only from the error and stop reason, its reset clock must sit within 120 characters of it, and a clock that elapsed moments ago retries now on every adapter path. The focused suite passes 34 cases.
  Independent review, publication, installed adoption, and a native recovery
  observation remain open. See
  [verification and rollout conditions](doc/evidence/acp-session-quota/verification.md).
- Private Paperclip integration continuation — Agent Settings#1620, host#129/import#126:
  2026-10-13 source qualification repaired timestamp precision, native fixture
  construction and nullable SDK context types. Current native binding19,
  host-boundary21, SDK39, OAuth/model/UI407, reader10 and plugin35 cases pass;
  strict plugin noemit and compile-only canary pass. These are separate source
  scopes, not installed/artifact/live-board proof. Independent e226 replay and
  staged/working preservation are recorded; installation, safe replacement,
  dependency closure, recovery, normal hooks/commit and human consent remain open.
  No public push or live import. See [current checkpoint and Next15](doc/evidence/project12-qualification-delta-20261013.md).

- [#154 — Stabilize workspace containment test completion](https://github.com/iMelki/paperclip/issues/154):
  Await tracked heartbeat executions before reading final state. The isolated
  database fixture delays agent finalization to expose the old one-second wait.
  Verification is recorded in `.gate-evidence.json` and
  `doc/evidence/issue-154/verification.md`. Co-CTO review, merge, and hosted CI
  remain open; this change does not update a live instance.

- [#148 — Keep newer Codex models visible in the picker](https://github.com/iMelki/paperclip/issues/148):
  The isolated candidate preserves declared Codex ordering in discovery and the
  ordinary picker. The exact server suite passed 21/21 and UI suite passed 14/14,
  including eight added regressions. Old production code failed the six expected
  sorting assertions, then the exact candidate was restored. The official token
  gate and full server no-emit typecheck passed. After repairing private SDK React
  bindings, the original full UI no-emit compiler passed in 121.84 seconds with
  empty complete captures and an owned process tree of zero. Its prior 120-second
  deadline remains recorded. Complete React warning captures are retained.
  Normal repository publication hooks, exact public-write approval,
  installed picker verification and saved-model/provider execution remain required.

- [#164 — Let Refresh Lockfile target dev](https://github.com/iMelki/paperclip/issues/164):
  Manual branch/base selection and isolated refresh branches are under CTO review.
  After the restart merge freeze lifts, merge the workflow fix and observe a dev
  dispatch before landing the lockfile update needed by PR #165.

- [#144 — Keep the listen port when only another address holds it](https://github.com/iMelki/paperclip/issues/144):
  The server now probes only its bind host, with an opt-in strict port. Seven
  real-socket tests and the startup suite pass locally; hosted CI and a
  non-author review are open. The Windows wildcard-listener limit is a
  follow-up. No live pin move is part of this change.

- [#33 — Preserve fixture data when stop is unresolved](https://github.com/iMelki/paperclip/issues/33):
  Bounded PR117 follow-up rejects failed-stop reclamation and prevents further
  startup retries. Six mocked tests pass; four deliberate-bypass failures prove
  the controls. Independent bounded review approved. Native ownership is still unproven;
  see [cleanup receipt](doc/evidence/pr117/cleanup-review.md).

- [#118 — Assess inherited PostgreSQL 18.1 security-version exposure](https://github.com/iMelki/paperclip/issues/118):
  current `dev` locks every embedded PostgreSQL artifact at 18.1.0-beta.16;
  the official CVE-2026-16239 fix is PostgreSQL 18.6. The latest wrapper line
  available to this project is 18.4.0-beta.17, so an ordinary dependency bump
  is not remediation. The installed Windows `pg_ctl.exe` is PostgreSQL 18.1
  (SHA-256 `4D51E03E…790FB1BEF`). Runtime exposure remains unknown because
  #95 blocks launch before listener/role inventory; select a verified >=18.6
  supplier or external patched PostgreSQL, then prove migration, lifecycle,
  rollback, and a negative path.

- [#121 — Reconcile trusted fork-review execution authority](https://github.com/iMelki/paperclip/issues/121):
  `pull_request_target` executes its trusted wrapper from default `master`,
  while normal development targets `dev`. Treat `master` as the authority until
  the release model changes; add a cross-ref contract guard, protect `dev` with
  required review/security checks, and prove deliberate drift fails. Do not
  check out untrusted PR-head code in the privileged workflow.

- [#126 — Adopt GitHub-to-Paperclip sync connector through observer-first rollout](https://github.com/iMelki/paperclip/issues/126):
  Host scope repair PR #128 and secured plugin PR #2 are merged. Historical
  plugin PR #1 is superseded and must not be merged. Current rollout is tracked
  in #129: private runtime, host integration, complete recovery rehearsal, and
  company-scoped secret validation precede one allowlisted import-only pilot.
  The current connector does not prove bounded no-dispatch import behavior.
  A separate exact-one-issue action is the scoped pilot design; require a
  company-bound secret reference and config path, one create-or-noop, no
  reconciliation or wake, and a twice-idempotent outer violation ledger.
  The plugin fork now has a clean local clone, but a scheduled full sync can
  activate a neutral import on its next tick. Production no-dispatch needs a
  reviewed durable company quarantine and explicit release; isolated-host
  characterization is not live rollout proof. See the
  [scoped design](https://github.com/iMelki/paperclip/issues/126#issuecomment-5865997370)
  and [scheduled-wake gate](https://github.com/iMelki/paperclip/issues/126#issuecomment-5866289762).

- [#140 — Harden Hermes Local launch boundaries](https://github.com/iMelki/paperclip/issues/140):
  Strict named-profile isolation, approval-bypass rejection, and a fresh-session
  prompt guard have focused tests; the final staged gate and publication must
  be read back separately. No live worker, effective credential, or provider-
  limit proof is claimed.

- [#35 — Windows embedded PostgreSQL startup](https://github.com/iMelki/paperclip/issues/35):
  2026-09-17 static confirmation shows the installed vendor patch uses
  restricted-process `pg_ctl` start and fast `pg_ctl` stop; focused mocked
  lifecycle tests passed 9/9 in 2.84s. This is not elevated native proof. A
  controlled, separately authorized disposable-cluster lifecycle receipt with
  final cleanup is still required.
  Latest 2026-09-13 checkpoint: published `4f2abb969` passed hosted build/test/
  typecheck/e2e jobs; trusted dependency review remains red. Independent review
  found CMD input handling and failed-start process ownership blockers.
  Follow-up Windows input guard has 15 mocked passes and deliberate-bypass
  negative proof; independent publication-only review approved patch SHA256
  `38956adc68dc390d096cb27ace051bc3a6bdf053834eb01c97f9d1ee82e5c19d`.
  This does not resolve native
  acceptance or cleanup. See [guard receipt](doc/evidence/pr117/guard-review.md)
  and [review checkpoint](doc/plans/2026-09-13-pr117-review-checkpoint.md).
  Earlier recovery history follows; its nine-test counts are historical.
  PR #117 is not superseded by dev `9f4a7e0aa`. Bounded correction committed
  on its existing branch: both pg_ctl spawn error listeners, windowsHide,
  nine no-DB mocked tests, explicit CI invocation, and base-identical lockfile.
  Existing pg_ctl -o CMD forwarding is an additional merge HOLD pending native
  command-line proof; original join semantics remain unchanged.
  Parent approved the narrow correction for publication on 2026-09-13;
  this is not merge approval. Independent rerun: 9 pass, 0 skip, 35.2 ms,
  with clean diff check. Earlier missing-dependency and offline-metadata failures
  were recovered through bounded registry provisioning and the existing plugin
  build helper. Normal pre-commit passed; correction `36182c123`, documented
  by `6ce1b282d`. Independent second-agent review approved that exact head for
  publication with no blocking code findings. Full-workspace provisioning also
  succeeded and normal pre-push full typecheck passed twice (198.3s / 168.1s).
  Exact-plan checks exposed concurrent docs edits, then missing dev ancestry;
  notes committed and dev `9f4a7e0aa` merged before a pristine retry.
  No hook bypass.
  Elevated Windows
  acceptance, descendant-window proof, trusted dependency review, final amended-head
  merge approval, and all-green CI remain open. No dependency label added.
  See [correction receipt](doc/plans/2026-09-12-pr117-correction.md) and
  [parent review](https://github.com/iMelki/paperclip/pull/117#issuecomment-5648622603).
  Preserved dev provenance (2026-09-10): the original author recorded a live
  unelevated initialise/start/createDatabase/stop pass with pg_ctl routing and
  cited zonkyio/embedded-postgres#66 for the restricted-token mechanism.
  This is historical evidence, not a fresh native rerun. Elevated acceptance
  was explicitly unverified; inspect server.log for data-directory ACL failures
  because initialise() still invokes initdb directly.

- #48 / #94 / #89 Historical gauntlet stash evidence preserved with a verified private archive; [dated provenance](docs/uiux/browser-evidence-2026-08-27/HISTORICAL-ARCHIVE-2026-09-08.md).

Last updated: 2026-09-28

- [#114 — Replay-safe cost imports](https://github.com/iMelki/paperclip/issues/114):
  scoped source identities, immutable replay conflicts and budget retry recovery
  implemented; heartbeat producer conversion is now tracked separately in
  [#124](https://github.com/iMelki/paperclip/issues/124) and remains open until
  its stable-identity, atomic-counter, replay, concurrency, and negative-proof
  criteria are delivered. See [contract](doc/cost-event-source-identity.md).
  Independent 2026-09-17 review requires the #124 contract to name the terminal
  identity tuple and eligibility predicate, atomically gate all runtime counters
  on a created cost event, supply a reconciliation entry point, and preserve
  newer runtime-state fields under out-of-order replay before implementation.
- [#116 — Reconcile historical migration snapshots](https://github.com/iMelki/paperclip/issues/116):
  generation exposes unrelated existing-schema drift; 0214 is scoped to cost
  identities. Snapshot reconciliation needs isolated upgrade proof.
- [#20 — Windows test process ownership](https://github.com/iMelki/paperclip/issues/20):
  The 2026-10-01 isolated DB discovery repair excludes compiled `dist` copies
  while retaining authored `src` and maintenance `scripts` tests. The exact
  CLI regression fails against the old config and passes after repair.
  See [discovery receipt](doc/evidence/db-test-discovery-2026-10-01.md).
  Topic PR review and hosted checks remain required; this is not native DB
  startup, process cleanup, Factory recovery, or live import acceptance.
  embedded-Postgres vendor spawns omit windowless flags. Cost import tests use a
  private canonical process host; upstream harness repair remains open.
  The access-route test's one-time import is now bounded suite setup (focused
  2/2 pass). Under the staged pre-commit gate, adapter-route per-test setup
  exceeded 30 seconds; its bounded 60-second setup passed focused 13/13.
  Complete-suite and zero-survivor process proof remain open.

## Historical Factory recovery

2026-08-25: [paperclip#95](https://github.com/iMelki/paperclip/issues/95) —
Windows factory start failed migrate (`42P07` / later `42703`) because the
Drizzle journal lagged the existing schema. Ledger repaired in `client.ts`
without wiping the factory DB. The current gate is post-PR #108 no-loss
fast-forward of the clean isolated factory checkout, then a governed wrapper
pin/path update and fresh owner/listener/version/health proof on port 5113.
2026-09-17 reconciliation: the isolated factory checkout is clean on current
`dev` `c497b1592649a068a58974365d4c6ccfcdcb7a2a`, but the shared
`PaperclipFactory.Common.ps1` pin remains
`1e3a74847f46691e8027fc55cf8deedd230223eb`. The `-WhatIf` provenance gate
correctly returns `blocked` with `head-mismatch, remote-dev-mismatch`; no start
was attempted. Repair #121's trusted-review authority before a reviewed pin
update, then re-run the no-start gate and a separately authorized lifecycle
test. Do not bypass provenance or fall back to the canonical checkout.

This file is the durable local index for active `paperclip` issues.

## Recently Closed Issues

- [#6 - Design and build a landing page](https://github.com/iMelki/paperclip/issues/6) — **closed 2026-09-26 as not planned**
  - Former goal: define and implement a landing page with clear audience, value proposition, proof, and CTA.

- [#5 - Use relevant skills for market research, competitor analysis, and monetization planning](https://github.com/iMelki/paperclip/issues/5) — **closed 2026-09-26 as not planned**
  - Former goal: map competitors, ICPs, monetization options, and positioning for paperclip.

- [#48 - Expand UI/UX Awwwards report (2026-08-09) into practical tasks](https://github.com/iMelki/paperclip/issues/48) — **closed 2026-09-26 as completed**
  - Moved from the Next 15 queue and the active list when GitHub closed it. The dated notes below are
    history from before the closure; the 2026-08-28 line saying no close predates it.
  - Fleet-wide code-only audit scored this app 7.8/10 against the shared
    Awwwards rubric. Full report: `docs/uiux-awwwards-report-2026-08-09.md`.
    Scores are code-inspection estimates pending a Frontend Proof Bundle.
    Portfolio tracking is maintained privately.
  - Gauntlet **21/21** (run 10, `f7a0160fc`, 2026-08-27): first-pass
    `/ASS/design-guide` rendered 16 capsules, `mainTextLen` 17664, empty
    `consoleErrors`. Receipt:
    `docs/uiux/browser-evidence-2026-08-27/gauntlet-run10-f7a0160fc.json`.
    #94 (six browser defects) and #89 (390 fine-pointer reflow) remain
    open and are not closed by this receipt.
  - 2026-08-28 carry: factory still `f7a0160fc` **21/21**. Awwwards **7.4**.
    Design-guide SVG fixed. Local UI commits `a384c4dc2` + `145720089` are
    **not** on origin. No issue close.

- [#77 - check-no-git-push extension allowlist is fail-open by omission](https://github.com/iMelki/paperclip/issues/77) — **closed 2026-09-26 as completed**
  - Index notes before closure (status then: local repair and proof complete):
  - The scanner now rejects every undeclared file type under its required roots.
    Only explicit declaration/document exclusions remain outside content scanning,
    so a newly introduced extension becomes a named integrity failure rather than
    disappearing from the denominator. A real scratch caller rejected the hostile
    unknown extension at exit 2, then passed after a hash-verified restore; hosted
    exact-head proof remains pending.

- [#115 — Honest provider and biller budgets](https://github.com/iMelki/paperclip/issues/115) — **closed 2026-09-17 after fresh focused UI validation**
  - `ProviderQuotaCard.test.tsx` passed 3/3 on current `dev`: recorded spend
    remains visible, provider and biller budgets render as Unallocated rather
    than fabricated company-budget shares, and provider-reported quota remains
    separate. No new UI component package was introduced.

- [#57 - Mixed-separator Windows paths broke tar sandbox commands](https://github.com/iMelki/paperclip/issues/57) — **closed 2026-09-01 after exact ancestry and current-tree audit**
  - The original diagnosis was too broad: the `ce906e60f` baseline already
    handled mixed separators in `shellQuotePath`. The observed failure was
    resolved by PR #66's removal of raw callback interpolation and PR #69's
    exported, hermetically tested Windows path helpers. Both merge commits are
    ancestors of `origin/dev`; the current delivery branch does not change the
    relevant files.

- [#58 - Windows command-managed-runtime tests hardcoded `/bin/sh`](https://github.com/iMelki/paperclip/issues/58) — **closed 2026-09-01 by PR #66/#69 evidence**
  - PR #66 repaired the two exact `/bin/sh` call sites. PR #69's final receipt
    records the command-managed-runtime suite at 23/23 with the exported shell
    resolver. Both fixes are ancestors of `origin/dev`; no remaining #58
    source delta exists on the current delivery branch.

- [#67 - PR CI did not validate the `dev` target](https://github.com/iMelki/paperclip/issues/67) — **closed 2026-09-01 after PR #78 and repeated hosted proof**
  - PR #78 made `.github/workflows/pr.yml` cover pull requests into both
    `master` and `dev`, prohibited `push`, and added a negative-proof policy
    gate. PRs #78, #79, #81, #83, and #99 each completed the 22-check PR
    workflow. The merge is an ancestor of `origin/dev`, so #67 is no longer an
    active bootstrap task.

- [#73 - Push lockout: the exhaustive pre-push gate rejected every push](https://github.com/iMelki/paperclip/issues/73) — **closed 2026-08-20 after PR #66 exact caller proof**
  - Commit `43011d50` changed the planner from the stale remote-topic baseline
    to the push destination's advertised `dev` object. PR #78 merged as
    `9983a44a`; the repaired PR #66 head then passed workflow `32092799583`
    and merged as `90bd179dd`. Current GitHub state is closed, so this is not
    an active task.

- [#70 - Test fixtures are not hermetic against host git config (insteadOf + autocrlf)](https://github.com/iMelki/paperclip/issues/70) — **closed 2026-08-18 by PR #69**
  - PR #69 squash-merged into `dev` at `987700f91` (PR head `670447a38`) with
    the full hosted matrix green and the exact-head CodeRabbit finding
    repaired. Fixture Git configuration is isolated (hostile `autocrlf` +
    `insteadOf` system config, empty global, `NOSYSTEM` guards) with positive
    and negative-control proofs, so the three former false failures pass
    hermetically: 18/18 on Windows. Closed manually because `dev` is not the
    default branch, so the PR's `Fixes #70` link could not auto-close.

- [#76 - Security gate fails open: incomplete tree coverage in check-no-git-push.mjs](https://github.com/iMelki/paperclip/issues/76) — **closed after the reopened fix; stronger adversarial hardening prepared**
  - The first repair closed unreadable-file/directory and zero-file failures.
    Reopened proof in `bf81b90e` then reproduced three live bypasses: renaming
    one required root still passed, a committed directory symlink dropped its
    whole target subtree, and `.mts`/`.cts`/`.jsx` files were unscanned. That
    upstream repair (`bf81b90e`, documented by `5a09494a`) declared roots,
    traversed links cycle-safely, added the extensions, improved tree telemetry,
    and wired the gate into pre-push.
  - The current hardening supersedes traversal with fail-closed rejection for
    symlinks, junctions, tracked generated/cache directories, unknown entries,
    encodings, and undeclared file types. It reconciles every tracked in-scope
    path against the visible tree, rejects skip-worktree/assume-unchanged index
    states before scanning substitute bytes, and uses language-aware detection
    for PowerShell here-strings, shell heredocs, and remote-mutating Git forms.
    Focused broken/restored receipts and the issue-state update are complete;
    #76 is closed. PR #78 completed its first repaired hosted matrix green;
    second-review hardening and portable evidence are complete, and the
    exact-head hosted readback completed via the PR #66 head `aeea981d2`
    (24 checks + expected neutral, merged as `90bd179dd`) and the PR #69
    matrices at `bbb37f640`/`670447a38` (merged as `987700f91`).

- [#82 - Review `getIssueCoordination` loader/projector split before further growth](https://github.com/iMelki/paperclip/issues/82) —
  **closed 2026-08-21 through merged PR #83**
  - PR #81 delivered the #52 company-scoped coordination repair as squash
    `7239123cf`. The #82 slice kept every company predicate inside private
    loader helpers and reduced `getIssueCoordination` from 181 to 8 nonblank
    lines. Pure projection receives an explicit clock and performs no database
    access, authorization, or filtering. The negative/restored proofs and
    42/42 final projector/route/isolation run are recorded in
    `doc/evidence/coordination-loader-projector/2026-08-21-issue82-receipt.json`.
    PR #83 merged into `dev` at `5efbc05824656b00d474fd47a2e55be17029a167`
    after exact-head hosted CI, CodeRabbit, independent security review, and
    human merge. #53 remains the separate evidence-truthfulness follow-up; it
    must not be represented as shipped by this behavior-preserving refactor.

- [#85 - Forbidden-token gate failed in linked worktrees](https://github.com/iMelki/paperclip/issues/85) — **closed 2026-09-01 as already delivered by PR #86**
  - `check-forbidden-tokens-core.cjs` resolves the shared private token file
    through `git rev-parse --git-common-dir`, while the repository-owned list
    stays clone-delivered. A real linked-worktree fixture proves the path avoids
    `.git/worktrees/<name>`, rejects a tracked private-token leak, and passes
    after the leak is scrubbed. Merge `8cbc9479010fc26a3ccae450a7d8453ab92c3628`
    is an ancestor of `origin/dev`; no duplicate implementation is required.

## Active Issues

- [ ] Focused per-dimension issues from the same capture (umbrella: #94):
  [#89 - fine-pointer 390 reflow/viewport escapes (11 surfaces, worst 284px)](https://github.com/iMelki/paperclip/issues/89) -
  [#90 - ~1,346 targets under the 24px AA floor at 1440](https://github.com/iMelki/paperclip/issues/90) -
  [#91 - contrast: 433 genuine 1.4.3 failures, micro-label token 1.96:1](https://github.com/iMelki/paperclip/issues/91) -
  [#92 - h1 at 14px on 32 surfaces / 13 without h1 / clipped placeholders](https://github.com/iMelki/paperclip/issues/92) -
  [#93 - single 6.78MB JS chunk on cold load](https://github.com/iMelki/paperclip/issues/93).
  Component-level detail and fix directions live in these five; a second full
  390 sweep (`capture-390-finepointer-router-derived.json`, fine-pointer,
  86 surfaces, 0 INCONCLUSIVE, DUPLICATE-REDIRECT outcome active) grounds #89.
- [ ] [#94 - Six UI defects found by the first browser capture](https://github.com/iMelki/paperclip/issues/94)
  - The first browser-measured evidence for this UI landed on `dev` at
    `docs/uiux/browser-evidence-2026-08-25/` (86 surfaces attempted, 80
    MEASURED, 6 NO-CONTENT, **0 INCONCLUSIVE**, exit 0). It re-scores the app
    **7.7 -> 7.2** against the fleet rubric; `SCORECARD.md` carries the reading
    and its own limits, `README.md` the method.
  - Six defects filed: `prefers-reduced-motion` not cascading past Tailwind
    utility timings; `h1` rendering at five computed sizes and absent on 13 of
    80 surfaces; 13.4% of light-theme text nodes below their contrast ratio
    (10px/500 uppercase labels at 2.3:1), against 5.1% in dark; 20.6% of targets
    under the WCAG 2.5.8 **AA** floor even with the coarse-pointer 44px floor
    active; no `<main>` landmark on `/onboarding` and the ux-lab routes; three
    project routes rendering one screen.
  - Improvement 9 of #48 is **done** and verified at this commit: all 16 native
    `window.confirm()` sites now use `useConfirmDialog` on the repo's
    `AlertDialog`.
  - Route-level code splitting remains the highest-value change and is now
    measured client-side: a cold dashboard load pulls 41 requests / 7,628,622 B,
    one JS file of 6,779,424 B, plus 37 JSON calls. Tracked in #48.
  - 2026-08-27: the gauntlet design-guide 404 is a separate showcase-fixture
    fix on `dev` (public SVG). Factory `:5113` on `f7a0160fc` now has a run 10
    **21/21** receipt (`docs/uiux/browser-evidence-2026-08-27/gauntlet-run10-f7a0160fc.json`).
    It does not close any of the six #94 defects or the #89 390 reflow list.
  - 2026-08-28 carry: factory still `f7a0160fc` **21/21** on `:5113`.
    Awwwards **7.4**. Design-guide SVG fixed. Local UI commits `a384c4dc2`
    + `145720089` are **not** on origin (`index.css` hook). Does not close
    #94/#89/#48.
  - 2026-08-27 UI slice (still open): members table now stacks below `md`;
    dashboard charts are one column before `sm`; `/onboarding` and the two
    lab routes that lacked a landmark now wrap in `<main>`; reduced-motion
    zeros Tailwind transition timings. Remaining on #94: h1 scale, light
    contrast, target sizes, project-route duplication. Remaining on #89:
    skill studio, design-guide, instance plugin/adapter tables, costs, and
    other escaped surfaces after a new 390 fine-pointer sweep.

- [#80 - Disposition matrix: extract, land, or retire preserved PR #45 without losing WIP](https://github.com/iMelki/paperclip/issues/80) — **no-loss census rechecked after #113; reviewed delivery pending**
  - The protected local and remote-tracking source refs both still resolve to
    `7bae4af253dfd96ac8a4d44807b479bcece01865`; PR #45 remains an open draft.
    The generated manifest owns all four commits, 162 commit/path rows, 131
    unique historical paths, and 3,032 unified-zero hunks with zero unowned or
    unknown rows. Twelve hunks are already landed with exact named-commit and
    pinned-current-tree evidence; 936 remain selective-extraction candidates,
    2,084 require semantic re-derivation, including all 2,000 remerge-diff
    hunks. Those reconstructed-merge differences can contain meaningful manual
    conflict resolution, so none is called stale without path-specific proof.
    The focused generator suite passed 5/5, including checked-in manifest
    validation and a recovery contract that never force-updates the protected
    local WIP branch,
    and `--check` reproduced the evidence under
    `doc/evidence/pr45-disposition/`; the 2026-09-06 `--check` rerun reproduced
    131 historical paths, 3,032 hunks, zero unowned/unknown rows after #113.
    No merge, wholesale cherry-pick, stash
    mutation, source-branch deletion, or evidence retirement is authorized.
    Generic or shallow checkouts now receive an explicit skipped-test reason,
    while the CLI itself fails closed before census work and prints exact
    unshallow and preservation-ref fetch commands.

- [#56 - Normalize Vitest scratch roots and prove abnormal-exit cleanup](https://github.com/iMelki/paperclip/issues/56)
  - Current `run-vitest-stable.mjs` creates `pcvt-*` roots, controls only
    `TMPDIR`, and does not own cleanup; on Windows, children commonly follow
    `TEMP`/`TMP` instead. The narrow planned fix is one outer
    `eph-paperclip-vitest-*` root with all three variables bound to it, a
    manifest/receipt, quiescence proof, and bounded same-run cleanup after
    success, failure, timeout, or interruption. A broad prefix sweeper is not
    acceptable because old roots can contain unrelated or secret-bearing state.

- [#65 - Consolidate duplicated process-tree termination](https://github.com/iMelki/paperclip/issues/65)
  - The original eight-site count is stale: the current audit finds five
    production raw teardown implementations plus support/vendored exceptions.
    The intended shared primitive is a zero-dependency
    `packages/process-custody` boundary with typed ownership and structured
    receipts. Migrate by risk and add a no-new-private-copy ratchet only after
    every production consumer has moved; PostgreSQL graceful shutdown and SSH
    remote teardown remain separate semantics, not forced consumers.

- [#108 - Harden Windows delivery, onboarding, and approvals](https://github.com/iMelki/paperclip/pull/108)
  - **Merged and on `dev`**; this was the reviewed-delivery vehicle for #47,
    #63, #80, #84, #87, and #88.
    The first hosted run exposed two stale Playwright adapter stubs; the
    repaired real journeys now pass 2/2 with authoritative Saved configuration
    readback. CodeRabbit's actionable findings had caller-shaped negative
    proofs; the final HTTP security set passes 34/34 and the independent server
    regression set passes 109/109. The stable-diff review found no P0/P1 code
    defect after exact evidence repair. Final commit/pre-push hooks, fresh
    exact-head hosted CI, and fresh exact-head automated review are complete;
    remaining work is limited to the explicitly listed issue residuals and
    the separate factory pin gate in #95.

- [#100 - Windows ACPX Gemini Version Probe Quoting](https://github.com/iMelki/paperclip/issues/100) — **completed and verified**
  - Uses `resolveWindowsCmdShell()` and `quoteForCmd(geminiBin)` with `windowsVerbatimArguments: true`
    to prevent argument splitting or command injection on paths with spaces/metacharacters.
  - Verified with comprehensive unit test suite in `command-path.test.ts` (13/13 passing).

- [#101 - Durable Approval Notifications via Transactional Outbox](https://github.com/iMelki/paperclip/issues/101) — **completed and verified**
  - Added queueing and exponential backoff retry dispatcher for approved hire notifications in `hire-hook.ts`.
  - Enqueued within the approval resolution flow to ensure at-least-once delivery semantics across transient failures.
  - Verified with unit tests in `hire-hook.test.ts` (6/6 passing).

- [#102 - Historical Approval Payloads Audit & Migration](https://github.com/iMelki/paperclip/issues/102) — **completed and verified**
  - Created standalone audit & migration script `server/scripts/audit-and-redact-approval-payloads.ts` supporting `--apply` and safe dry-run modes.
  - Reuses `redactHireApprovalPayloadForPersistence` to redact legacy unredacted plaintext secret values while preserving empty native-auth bindings.
  - Verified with unit tests in `hire-approval-payload.test.ts` (20/20 passing).

- [#104 - Structured HTTP Error-Context Allowlisting and Redaction](https://github.com/iMelki/paperclip/issues/104) — **completed and verified**
  - In `server/src/middleware/http-logger.ts`, replaced arbitrary message interpolation in `customErrorMessage` with static safe string `request failed`.
  - Allowlisted safe `errorContext` keys (`code`, `name`, `statusCode`, `status`, `path`, `reason`) and dropped raw error traces, inner message strings, and credentials.
  - Verified with test suite in `http-log-redaction.test.ts` (6/6 passing).

- [#106 & #107 - Onboarding Wizard Step Controller & Orchestration Extraction](https://github.com/iMelki/paperclip/issues/107) — **completed and verified**
  - Extracted Step 4/5 lead hire and heartbeat coordination logic out of `OnboardingWizard.tsx` into modular custom hook `ui/src/hooks/useOnboardingHeartbeatCoordinator.ts`.
  - Reduced `handleGiveHeartbeat` from ~120 lines to a clean delegate (< 30 lines) while preserving exact UI behavior, verification flow, error handling, and Radix/Shadcn presentation without building UI primitives from scratch.
  - Verified with `OnboardingWizard.config-persistence.test.tsx` (7/7 passing) and UI typecheck.

- [#109 - Make dependency-review approval status explicit](https://github.com/iMelki/paperclip/issues/109)
  - Open governance follow-up. Separate dependency approval from generic review
    labels and make trusted-maintainer grant, revocation, and exact-head status
    observable and fail closed.

- [#110 - Ratchet local shell/tool spawn boundaries](https://github.com/iMelki/paperclip/issues/110)
  - Open broader follow-up beyond #63's SSH scope. Inventory local launch sites,
    migrate safe consumers to canonical helpers, then add a caller-shaped
    no-new-private-copy gate.

- [#111 - Remove contributor-home paths and add a portability/privacy ratchet](https://github.com/iMelki/paperclip/issues/111)
  - Open current-tip cleanup; no history rewrite or force-push. Replace local
    home paths with repository-relative links or neutral placeholders and add a
    prospective cross-platform documentation check.

- [#112 - Fail closed when Cursor `--trust` is unsupported](https://github.com/iMelki/paperclip/issues/112)
  - Open provider-capability follow-up. Probe or pin an authoritative minimum
    version, emit an actionable error, and never substitute `--force`, `--yolo`,
    or another approval bypass.

- [#62 - Windows: symlinks do not survive the tar create/extract round-trip in runtime asset sync](https://github.com/iMelki/paperclip/issues/62)
  - Open remote tar-transport follow-up. Not addressed by PR #66/#69; keep with
    the #47 remote-tar cluster.

- [#64 - Security: the ACP bridge payload forwards the whole host env to the sandbox provider](https://github.com/iMelki/paperclip/issues/64)
  - Open. The environment transport remains bounded per the PR #66 changelog
    entry; reducing or replacing the oversized ambient-env payload (and its
    unrelated-secret exposure) remains this issue's scope.

- [#46 - Make React Doctor hook execution reproducible and fail closed](https://github.com/iMelki/paperclip/issues/46)
  - Commit `124a48cc` removed the floating `npx react-doctor@latest` path and
    added bounded local resolution, minimized child environment, normalized
    receipts, timeout/termination handling, and negative-proof evidence. The
    quality gate remains explicitly disabled. Exact `react-doctor@0.7.8` is
    Modified MIT (not SPDX MIT) and requires written permission for automated
    ML/AI pipeline use and certain hosted offerings. Do not declare it in the
    manifest/lockfile until usage approval, dependency/advisory closure,
    offline/Windows/Linux, and authenticated-consumer qualification evidence
    are all recorded. The unavailable package must keep producing its visible
    incomplete receipt rather than silently passing.

- [#68 - Deep gitleaks history scan fails; no pushed-range mode](https://github.com/iMelki/paperclip/issues/68)
  - `verify-gitleaks.mjs --history` exits 2 with 24 pre-existing findings across 7837
    commits, all in test fixtures and mock data. The pre-push gate therefore does not
    call it: an unpassable gate trains everyone into `--no-verify`, which would also
    disable the full typecheck and suite. Exact `--range <base>..<head>` support
    and local outgoing-range scans are prepared for pre-push and PR CI. Triaging
    the 24 historical findings remains open; they are deliberately outside the
    new commit ranges.

- [#71 - Pre-commit exceeds its declared budget; 87% of the cost is vitest module import](https://github.com/iMelki/paperclip/issues/71)
  - `CONTRIBUTING.md` now declares the budget (p95 <= 90 s, hard cap 180 s) and this repo
    does not meet it: measured 2026-08-13, a capped 12-suite hub run spent 227.8 s of
    262.7 s importing modules and only 29.6 s executing tests. Because cost scales with
    suite *count*, no cap value closes the gap — hitting 90 s needs a cap of ~3-4 of 159
    relevant suites. Fix per-suite import cost, not the selection strategy. Related: the
    affected-package typecheck buys less than assumed (`pnpm -r` already parallelizes, so
    the 32-package sweep costs ~the slowest package), and the previously cited "~13 min
    `pnpm -r typecheck`" baseline did not reproduce (184.3 s warm).
  - 2026-08-18: related selections now launch every capped or uncapped suite in
    a separate Vitest process. The real PR #66 commit hook resolved 322
    candidates, ran the 12 closest suites, and passed 335 tests with 21 declared
    platform skips. This fixes cross-suite state leakage but not the budget:
    the largest suite alone took 189.3 s on the recovered host, so #71 remains
    open.

- [Day-0 branch/worktree consolidation plan](doc/plans/2026-08-02-day0-branch-consolidation.md)
  - Preserve concurrent dirty branches and locked worktrees. Consolidate only
    after receipt, independent review, exact-path release, and remote-SHA
    readback. Builder worktrees never push; the Integrator primary checkout
    performs release. Current Paperclip and MCK runtime gates remain open.

- [#24 - Defer dev-runtime restarts while factory runs are active](https://github.com/iMelki/paperclip/issues/24)
  - Automatic source-change restarts can currently terminate a live factory
    heartbeat and leave the run as `process_lost`. Add an active-run drain
    gate with a bounded deadline, explicit operator-visible deferral evidence,
    and restart/recovery coverage before relying on the dev watcher during
    self-hosted factory delivery. The first Builder interruption is preserved
    in the issue as reproducible evidence; this does not block source work
    while no heartbeat is running.

- [#23 - Tool Gateway catalog and health omit configured static headers](https://github.com/iMelki/paperclip/issues/23)
  - One fail-closed header policy now governs gallery discovery, health, and
    execution. Static non-secret headers are delivered without allowing caller
    config to override the gallery URL, quarantine, managed credentials, or
    MCP protocol headers. The final hardening also rejects secret-shaped values
    hidden under benign names, non-ByteString values, unsupported versions, and
    oversized streamed responses. The complete matrix exposed and repaired a
    stale gallery fixture that expected new tools to bypass their mandatory
    pending-review state. Close after the refreshed complete matrix and a live
    GitHub MCP read-only catalog probe succeed on the committed runtime.

- [#21 - Allow company import to preserve explicit Process adapters](https://github.com/iMelki/paperclip/issues/21)
  - `company import --adapter-strategy preserve` now retains reviewed,
    explicitly exported Process validators and records their slugs in text and
    JSON preview/apply evidence. Close after the focused E2E, CLI typecheck,
    complete validation, commit, and remote-SHA readback are green.

- [#20 - Reap Windows test process trees and remove load-order timeout flakes](https://github.com/iMelki/paperclip/issues/20)
  - All 125 embedded-PostgreSQL hooks that previously overrode setup with an
    explicit 20-second bound now use one shared 60-second Windows / 20-second
    non-Windows constant, with an AST regression guard. Windows teardown now
    captures creation-time identities, reaps the complete exact tree, follows
    reparented descendants, rejects reused PIDs, and fails closed when
    ownership cannot be proved. The two observed loaded-host checks now use
    bounded 30-second and 20-second limits and pass together, while explicit
    dependency globs prevent spurious Windows watcher restarts. Keep this issue
    open until the fresh
    complete-suite receipt is green with zero surviving fixtures. The POSIX
    runtime-service adoption fallback now bounds its full `ps` parent-lineage
    walk to two seconds, including hung command/parent probes; the regression
    test uses a deliberately non-returning `ps` executable. The nine recovery
    tests omitted during upstream conflict resolution remain a separate,
    explicitly tracked follow-up and are not restored by this slice. The
    workspace-busy retry handoff now keeps the source run non-terminal until
    its `scheduled_retry` child is inserted and linked, closing the
    cancelled-without-retry race covered by the existing heartbeat assertions
    at lines 569, 667, and 858.

- [#22 - Make complete validation and package builds Windows-portable](https://github.com/iMelki/paperclip/issues/22)
  - The portable Node filesystem helper, validated direct package-manager
    entrypoint, native path assertions, timezone-stable UI fixtures, dependency
    scan boundary, and current package-build assertions are implemented. The
    final audit also found remaining host-side bare npm/pnpm executions,
    POSIX prepack/postpack pairs, and missing native-Windows CI coverage; finish
    those canonical resolver/lifecycle consumers before the fresh full matrix,
    typecheck, build, and representative pack readback.
  - 2026-08-12: normalized discovered package directories to the manifest's
    POSIX separator form and added a cross-host regression; this removes the
    deterministic Windows `release-package-map list/check` mismatch. The
    remaining lifecycle, pack, full-matrix, and process-cleanup gates stay open.
  - 2026-08-12: replaced the nine published-package `rm`/`cp`/`mv` lifecycle
    fragments with shared Node prepare/restore helpers. Collision, generator
    failure, byte-preserving restore, and manifest wiring tests pass. Server
    `bash`/cleanup scripts and the remaining full pack matrix are separate gates.
  - 2026-08-12: fixed host-native Codex sandbox home separators found by the
    normal hook (the sibling exact-case `SKILL.md` directory-detection fix
    landed on `dev` separately). Existing focused suites cover the path.
  - 2026-08-18: the real PR #66 commit hook exposed one additional baseline
    cluster: Codex credential tests required POSIX `0600`/`0700` bits from
    Windows `stat`, one fixture invoked bare `sh`, and one diagnostic test
    built temp prefixes with a literal `/`. The portable repair keeps
    credential/rotation behavior on every platform, reserves permission-only
    checks for POSIX, uses the reviewed Git-for-Windows shell resolver, and
    joins host temp paths natively. The broader issue remains open for its
    complete Windows validation acceptance criteria and Windows ACL proof.
    (This consolidates the former duplicate #22 entry.)

- [#19 - Make headless onboarding and doctor failures automation-safe](https://github.com/iMelki/paperclip/issues/19)
  - Implemented explicit config-only `onboard --yes --no-run` behavior and
    nonzero failed-doctor process status. The recorded Windows instance is
    currently stopped/stale; close only after the committed CLI materializes
    config, doctor, controlled restart, and provenance readback all pass.

- [#16 - Configure the Assistants day-0 software factory](https://github.com/iMelki/paperclip/issues/16)
  - Configure the local company, goals, budgets, role agents, execution policy,
    routines, workspaces, Tool Gateway, Smoke Lab, deterministic validator, and
    secret-scrubbed export for the MCK golden path.
  - The first live deterministic Validator exposed two fail-closed integration
    defects: direct-parent reads needed a narrowly scoped Process/run
    authorization exception, and PowerShell REST array results required
    explicit enumeration. Both repairs now have focused regression coverage;
    resume the factory only after the Agent Settings wrapper is pushed and the
    live Validator retry succeeds.

- [#15 - Provision native and WSL Paperclip factory runtimes](https://github.com/iMelki/paperclip/issues/15)
  - Prove the loopback-only Windows instance first, then the Ubuntu 24.04
    Bubblewrap shadow instance with pinned Node, pnpm, and Codex versions.

- [#26 - Day-0 software-factory promotion PR](https://github.com/iMelki/paperclip/pull/26)
  - Real non-draft PR `dev → master`, head `4565e1a86`, with required CI run
    `31264764346` fully green (including all three E2E shards), fresh history
    Gitleaks green, and native runtime provenance read back. Current runtime
    was restarted from that exact SHA at `2026-08-08T15:44:37.349Z`. Never merge until
    formal independent review, the MCK #135/#136 bridge gates, a fresh
    Builder→Validator→Reviewer→release receipt, and MCK #46 evidence are
    complete.

- [#42 - Make E2E teardown await or tolerate late heartbeat finalizers](https://github.com/iMelki/paperclip/issues/42)
  - Open follow-up for asynchronous teardown FK/deadlock noise documented by
    upstream issues #9366/#9761. It is not causal for the repaired US-1
    catalog-review fixture, but it must be fixed before teardown evidence is
    called clean.

- Historical Gitleaks inventory
  - Refreshed 2026-08-08 at current `dev` head `902118b6` with Gitleaks 8.30.1:
    7,263 commits / 250.07 MB,
    64 reviewed synthetic/history-only findings, zero unignored leaks. Exact
    inventory and fingerprints are in `doc/security/gitleaks-history-inventory-2026-08-02.md`;
    the current report is the paired `paperclip-gitleaks-history-902118b6.stdout.log` /
    `paperclip-gitleaks-history-902118b6.stderr.log` artifacts under
    `S:\source\CCAI\Assistants\_factory-work`;
    no active credential rotation was warranted.

- [#13 - Replace inert secrets-filter attributes with enforced secret scanning](https://github.com/iMelki/paperclip/issues/13)
  - 2026-07-14: selected explicit scanning-only policy, removed the six inert
    `filter=secrets` declarations, and restored a zero-warning repo-health
    audit.
  - 2026-07-16: pinned Gitleaks `8.30.1` and the official Linux/Windows x64
    release checksums; local hooks now fail closed when the binary is absent,
    wrong, broken, or reports a finding. The PR `verify` and `e2e` jobs depend
    on a checksum-verified full-history scan. Local proof scanned `3,633`
    commits / `101.82 MB` in `8.77s` with zero unignored findings after exact
    review of 18 repeated synthetic/generated fingerprints. `master` still has
    no branch protection or ruleset, so keep #13 open until the scanner check
    has a capacity-approved GitHub run and can be made a required status check.

- [#10 - Add native Antigravity adapter and retire legacy gemini_local path](https://github.com/iMelki/paperclip/issues/10)
  - Current upstream added a native Gemini ACP lane, so `gemini_local` is no
    longer legacy-only. Reassess the remaining Antigravity-specific value
    instead of removing the current adapter.

## Recently Completed

- [x] [Projects Ops #117 - Enroll Paperclip in Repo Doctor](https://github.com/iMelki/projects-ops/issues/117)
  - The governed checkout now has an observe-only `on_demand` genome with four
    bounded authored-source sets, 3,246 selected files, two explicit generated
    exclusions, and no analyzer execution or quality authority. The direct
    invalid-reference proof failed closed as direct `invalid`/2 and shared
    `invalid_genome`/2, with private issue text withheld. The restored
    direct/shared plan resolution passed at 3,246 selected files and two
    exclusions. Agent Settings fixed the classification contract in
    `c91e70cc`; an invalid genome remains non-green and no analyzer ran.

- [#53 - Make coordination evidence and health fail closed](https://github.com/iMelki/paperclip/issues/53) — **merged via PR #113 (`715b453bc`)**
  - #82 is closed and is no longer a blocker. The remaining v2 contract is an
    additive presentation-only route at
    `/api/issues/:rootIssueId/coordination/v2`, backed by migration `0213` and
    the exact vendored Projects Ops schema (SHA-256
    `3f47037b1f7b5e1705e719e4b087be88223abac19590521024d2f8960823b258`).
    `unassigned` is a non-authorizing sentinel; unknown, malformed, stale, or
    ownership-mismatched facts stay non-positive and can never be projected as
    healthy. Existing v1 behavior remains untouched. The real same-company and
    foreign-company HTTP isolation cases pass, along with 5/5 v2 tests,
    caller-shaped negative proofs, server/db typechecks, and the DB contract
    suite. The preserved PR #45/p53 commits remain evidence inputs, not
    cherry-pick authority. PR #113 passed fresh exact-head CI; CodeRabbit's
    three actionable findings were fixed before merge, while a follow-up
    CodeRabbit run was rate-limited and Cursor's review lanes were neutral due
    the team usage cap.

- [#84 - Clarify or restore the Greptile 5/5 merge gate](https://github.com/iMelki/paperclip/issues/84) — **closed as completed in merged PR #108**
  - Decision shipped in merged PR #108: Greptile is
    optional and must be marked N/A when unconfigured. CodeRabbit is primary;
    exact-head Cursor Bugbot/review is the documented fallback. CI and human
    review remain separate. The old 5/5 sentence failed the real policy test,
    and the restored policy passed 4/4.

- [#87 - Bug: onboarding shows Codex but persists Claude adapter](https://github.com/iMelki/paperclip/issues/87) — **closed as completed in merged PR #108**
  - Delivered in merged PR #108. A returning flow now updates
    the existing lead through a custody-preserving PATCH. Same-adapter resumes
    retain hidden ACP/profile/arguments/workspace/runtime/timeout policy and
    merge only onboarding-owned edits; adapter changes still discard stale
    adapter-specific state/model. Review reads the saved agent and requires the
    server-normalized saved config, not only adapter/model. Pending, failed,
    mismatched, or reload-without-exact-expectation readback blocks **Get
    started** with an accessible alert. Returning agents test the effective
    merged command/cwd/env configuration before PATCH. The final set passed
    21/21 plus the task-owned UI typecheck. Deliberate launch-gate,
    destructive-replace, and draft-instead-of-effective-config controls failed
    for their exact reasons before byte restoration. Independent stable-diff
    review is GO with no P0/P1 after evidence repair. #105 owns opaque
    revision/CAS hardening and #107
    owns the accepted Wizard reduction follow-up.
    Fresh browser proof passes both affected journeys and verifies Saved
    configuration as Verified / Claude Code / Adapter default before enabling
    **Get started**; the intercept no longer swaps the submitted adapter to an
    inert HTTP stub and disables only automatic wakes.

- [#88 - Pending Codex hire approval redacts intentional empty API key and leaves agent stuck](https://github.com/iMelki/paperclip/issues/88) — **closed as completed in merged PR #108**
  - Delivered in merged PR #108; the remaining linked work is tracked in #101,
    #102, #103, and #104. Exact-empty plain bindings survive
    while non-empty and
    whitespace-only secrets remain redacted. Hire preparation is enforced at
    the service boundary, same-company pending baselines are required for
    restoration, approval/activation/reconciliation/budget writes are one
    transaction, and notification starts after commit. Standalone approvals
    apply icon, runtime config, default environment, and restrictive permissions
    exactly; request-revision and resubmit transitions use status predicates.
    Ambiguous bare `token`, camelCase private-key/secret/token credentials, and
    provider-prefixed request keys are redacted from actual pino output. The
    final HTTP policy/redactor/pino set passed 34/34 after its deliberately
    broken control failed eight exact assertions for query, context, route,
    path-token, code-alias, plain-binding, and URL/URI leaks. The independent
    server regression set passes 109/109; the prior post-review set passed 47/47,
    including embedded-Postgres exact readback and a two-connection stale-writer
    barrier; its three deliberately broken controls failed for the expected
    privilege, race, and log-canary reasons before exact restoration. Earlier
    custody/transaction/logging proof passed 68/68 and built-in, route, and
    plugin ingress regressions passed 54/54, all with C:-resident scratch.
    The task-owned server typecheck exited 0. Separate residuals stay open as
    [#101 - durable approval notification outbox](https://github.com/iMelki/paperclip/issues/101),
    [#102 - historical approval secret audit/migration](https://github.com/iMelki/paperclip/issues/102),
    [#103 - atomic pending-agent plus approval creation](https://github.com/iMelki/paperclip/issues/103),
    and [#104 - allowlisted structured error-context logs](https://github.com/iMelki/paperclip/issues/104).
    PR-review follow-up also strips query strings from request logs, redacts
    connection-string variants, rejects array metadata, proves budget writes
    use the transaction handle, and proves resubmit forwards the exact guarded
    payload instead of the raw secret-bearing object.

- [#105 - Use server-owned adapter-config revisions for onboarding verification and CAS](https://github.com/iMelki/paperclip/issues/105) — **completed and verified**
  - Exposed opaque server-computed `adapterConfigRevision` on `redactAgentConfiguration` / agent detail responses.
  - Enforced compare-and-set concurrency validation on `PATCH /agents/:id` via `expectedRevision`, `expectedAdapterConfigRevision`, and `If-Match` header with 409 Conflict rejection.
  - Schema extended in `packages/shared/src/validators/agent.ts`.

- [#63 - Shell-safety siblings: git-workspace-sync legacy quoter, bare-sh spawns, unguarded postUploadCommand](https://github.com/iMelki/paperclip/issues/63) — **closed as completed in merged PR #108**
  - PR #69 (squash `987700f91`, 2026-08-18) aliased `git-workspace-sync` to
    `shellQuotePath`, routed the six bare-`sh` test spawns through
    `resolveTestShellCommand`, and exported `quoteSandboxProvisionPath` /
    `buildSandboxRuntimeAssetExtractCommand` as the provision contract. The
    exact-head CodeRabbit review also fixed the `mkdir` parent derivation with
    `dirnamePortablePath` — the #36 defect class at the git-workspace-sync
    site. PR #108's delivery branch reuses the canonical `shellQuote` in the
    remote managed runtime, and a structural test rejects another private copy.
    The SSH env-lab preflight now includes every local command it invokes,
    including `ps` for descendant discovery. Both SSH support detection and
    fixture startup now use the shell-free
    PATH/PATHEXT resolver shared with `server-utils`. Independent review rejected
    the first resolver/ratchet pass because it did not fully preserve Node PATH
    semantics or prove the invoked gate could fail. The source-only repair now
    handles unset and empty POSIX PATH, file-type plus access checks,
    platform-correct path-like commands, case-insensitive Windows environment
    keys, current-process PATH fallback when a Windows child environment omits
    PATH, the documented PATHEXT default, aliased `/bin/sh` plus argv forms, and
    named child-process import aliases such as `spawn as run`.
    Package `typecheck` now invokes the exact gate first. The real package
    caller exited 1 for both `/bin/sh` and named-import `/usr/bin/bash`
    interpolation fixtures, exited 0 for passive text and restored `ssh.ts`,
    and the final focused adapter-utils set passed 41/41. The ratchet now also proves
    `which` under zsh with a composite `-ec` command flag, and covers the common
    sh/bash/dash/zsh/ksh/ash shell names. The receipt also corrects the pnpm
    forwarding syntax to `--source` (an extra `--` is forwarded literally and
    produces the CLI's usage error). Package typecheck passed inside the
    reviewed task-owned runner; earlier first-pass typecheck evidence stays
    superseded. The `remote-managed-runtime.ts` host-local `localPath` check now
    accepts both POSIX and Windows absolute paths, and its focused Windows tests
    pass. The SSH-specific AST ratchet prevents new shell-backed `command -v`
    or `which` lookups across the supported local shell/argv forms. ACPX/Gemini
    interpolation remains separately tracked in #100 and is intentionally
    outside this SSH-specific change. The post-review focused set passes 22/22
    and the full #63 focused set passes 39/39; exact-head hosted proof remains
    pending.

- [#47 - dev tip fails 2 Windows path tests — hook rejects all commits](https://github.com/iMelki/paperclip/issues/47) — **closed as completed in merged PR #108**
  - Delivered in merged PR #108. `remote-managed-runtime.ts` now treats its
    `localPath` as a host path and accepts either POSIX or Windows absolute
    forms while retaining POSIX remote sandbox paths. The two formerly failing
    Windows cases pass. The real old-head push hook receipt
    `d5f924ecfaf943189522a2e94b772e49` passed the complete 22m57s caller inside
    an identity-bound Job Object with disk-pressure monitoring and zero
    survivors. PR #108's final pre-push, exact-head hosted CI, and automated
    review are complete; no additional delivery gate remains for this fix.


- [#18 - Isolate nested Git tests from hook-local index state](https://github.com/iMelki/paperclip/issues/18)
  - Completed after the stable runner isolated hook-local Git state, all six
    affected worktree suites passed, and the exact pushed merge was read back.
- [#17 - Make the custom-image terminal WebSocket readiness wait deterministic](https://github.com/iMelki/paperclip/issues/17)
  - Completed with bounded asynchronous readiness polling and native-Windows
    regression coverage.
- [#14 - Assimilate current upstream and harden Codex execution](https://github.com/iMelki/paperclip/issues/14)
  - Completed by merging the reviewed upstream SHA and shipping the current
    Tool Gateway, plugin tenancy, Codex execution, and recovery hardening.
- [#12 - Reconcile preserved Windows runtime and OpenAPI worktree batch](https://github.com/iMelki/paperclip/issues/12)
  - Completed after the preserved Windows/runtime batch was split, validated,
    pushed, and reconciled with upstream's schema-backed OpenAPI surface.
- [#11 - Default new UI-created agents to permission prompts enabled](https://github.com/iMelki/paperclip/issues/11)
  - 2026-07-11: new UI-created Claude and OpenCode agents now default permission bypass off; focused regression coverage and adapter documentation preserve the legacy omitted-config fallback and explicit unattended onboarding path.

- [#9 - Fix Windows pre-commit sandbox and plugin typecheck failures](https://github.com/iMelki/paperclip/issues/9)
  - 2026-06-23: added a Windows-native PowerShell pre-commit checker, made
    Husky prefer it when `pwsh` is available, verified the clean staged-files
    smoke passes, and verified plugin build dependency prep passes.
- [#7 - Backfill secrets hygiene and governance baseline after modernization audit wave 3](https://github.com/iMelki/paperclip/issues/7)
  - 2026-06-23: confirmed the wave-3 governance baseline is present and
    `Invoke-RepoHealthAudit.ps1 -Json` reports `grade=OK`, `fail=0`.
  - 2026-07-14: the remaining policy-unknown warnings were resolved by the
    scanning-only policy tracked in #13.
- [#3 - Review and split preserved remote execution and continuation WIP](https://github.com/iMelki/paperclip/issues/3)
  - Closed after the preserved remote-execution and continuation work was
    reviewed and split out of the active task lane.
- [#1 - Adopt projects-ops repo bootstrap governance baseline](https://github.com/iMelki/paperclip/issues/1)
  - Completed via [PR #2](https://github.com/iMelki/paperclip/pull/2) on 2026-05-10.

## Supporting Docs

- [AGENTS.md](AGENTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [.github/labels.yml](.github/labels.yml)

## Active GitHub Issues

- [#129 - Factory host modernization for secured GitHub plugin rollout](https://github.com/iMelki/paperclip/issues/129)
  - As of 2026-09-28, the Windows Factory on port 5113 is unavailable, and the
    clean isolated checkout's old head differs from the governed wrapper pin.
    Do not bypass provenance, restart into automatic migrations, or install the
    secured current-main plugin until an isolated data-copy qualification proves
    the matching host, private Node runtime, backup/restore (including the
    intentional Codex credential-pointer contract), and import-only smoke path.

- [#140 - Harden Hermes Local adapter isolation and test registration](https://github.com/iMelki/paperclip/issues/140)
  - Local `dev` commit `99b3d604` is not published: the pre-push gate exposed
    two missing sibling suites and an unregistered Hermes Vitest project.
    Both sibling suites now pass; root selection and PR group registration are
    prepared locally. The normal gate requires a topic-branch PR and hosted CI
    for policy/config changes. Effective auth, provider hard stop, sandbox,
    and bounded live-dispatch proof remain separate pilot gates.

- [#130 - Fix Windows GitHub-plugin E2E harness npx launcher](https://github.com/iMelki/paperclip/issues/130)
  - Fixed in `paperclip-github-plugin` PR #3 (`2cff6ee`): Windows harnesses now
    invoke npm's bundled npx CLI through Node without a shell. The full local
    aggregate suite still has a separate CRLF assertion on an unchanged file.

## Dated history — private GitHub Projects continuation (2026-10-13)

> Copied verbatim from the former c0 WIP continuation. Counts, timestamps and pending
> states below are historical evidence, not current validation, installed behavior or consent.

- [#126 / #129 — Personal GitHub Projects and browser connection](https://github.com/iMelki/paperclip/issues/126):
  2026-10-13 private continuation: correct OAuth app registered metadata read back
  without secrets; exact approved callback uses5113. Human secret/consent remain
  pending. Native RW OAuth wizard, twelve bounded
  operations, current-account/scope/expiry verification and formal write
  approval are source candidates, not installed. Latest admitted run385 passed
  across9 files; one model suite collected0 due borrowed acpx/runtime resolution.
  The existing patched dependency was found and narrow resolver/pins reviewed;
  full406 rerun pending. Earlier scrollIntoView failure now passes AppsConnect28/28.
  Newer-model form render14/14 passed; installed/provider proof remains absent.
  Newer-model four-file source integration and
  host-owned Project12 OAuth binding/fixed reader/attestation are in parallel
  private qualification. Existing Asimtop/MemSys browser is usable on HTTPS5113,
  but its board link is still reference-only and live import pass count remains0.
  Effective dependency declarations match the lock after pinned pnpm overrides;
  preliminary raw Lexical mismatch classification is withdrawn. No lock rewrite.
  Guarded-call assertion and legacy fake-act/root/client cleanup repaired.
  Native service/state source review accepted; full candidate review and all
  latest reruns/native fixtures/full compilers remain open. Latest admission
  refused95.6316317381% RAM at23:46:00Z after resolver repair (90% limit),
  no child; raw66786036/2917460 total/freeKiB. The earlier actual385 run was
  53.712s/exit1;15 processes terminal,0active, complete captures/no drift.
  New conservative CIM-start/age guards source reviewed, negatives pending.
  Host hooks/commit remain pending.
  Single-transaction credential/binding/attestation custody and contradictory
  complete-result recovery are source repaired/reviewed; new fixtures unrun.
  Human safe-close action acknowledged; it did not clear admission. No unknown
  processes stopped, protected Kanban3021 unchanged. Same app healthok23:51:40Z.
  Private adoption also needs qualified launcher candidate-vs-remote-base pins,
  preservation-safe backup/artifact replacement and durable stock-sync fencing:
  ordinary backup can prune; plugin unload(purge=false) can remove artifacts;
  current upgrade cannot change local path and load can resume paused jobs.
  These are newly tracked rollout defects, not executed operations or permission.
  No agent grants, installs or imports run on Connect. Publication is held;
  see [OAuth qualification and bug log](doc/evidence/github-oauth-workspace-20261013.md).

## Current private qualification — 2026-10-13

- Paperclip #126/#129, private agent-settings #1620: source-only local plugin
  pointer persistence and paused-job retention repair adopted in the existing
  independent e226 candidate after two non-author source reviews. Three
  regression files contain 17 UNRUN cases; the extra duplicate fixture is excluded.
  No original mixed index, serving checkout, database, secret or live plugin changed.
- Dependency lock reader's exact-indent repair passed 12 source-bound Node cases.
  The next actual plan refused a legitimate Drizzle optional-peer normalization
  mismatch. Official pnpm9.15.4 provenance explains metadata-only prisma wildcard;
  exact effective-peer successor/negative checks are being prepared. No dependency
  plan/apply/build/installation or live import acceptance from that result.
- Fresh desktop and tailnet5113 health both reported ok/authenticated/private
  at 20:24:01/05 UTC. RAM94.928% exceeded the90% heavy-run ceiling; no unknown
  process or protected app was stopped. Recovered samples do not waive other gates.
- Compiler launcher0C6C: actual WhatIf exit0/nochild and missing-evidence exit1
  with required-reviewed-evidence-missing/nochild at20:21 UTC. Full compiler,
  normal-hook closure and commit remain pending. Public writes are forbidden.
- Owner: root Paperclip integration. Finish dependency plan/readback and actual
  compilers/17 fixtures, then exact artifact/inert-install/pilot qualification.
  Human alone Authorizes. Project12 binding and two real imports remain0.
  See [private source checkpoint](doc/evidence/project12-qualification-delta-20261013.md).

### Fresh private continuation — 2026-10-14 local / 22:41 UTC Oct13

- Paperclip #126/#129, private agent-settings #1620: actual dotted-scope source
  suite30 passed; full dependency plan STILL refused native2 at Vitest. Exact
  pnpm9.15.4 autoInstallPeers:true preprocessing is missing before own-peer
  exclusion (required vite incorrectly dropped,11 versus12 peers). Locks match;
  no supplier corruption, mismatch waiver or lock rewrite. Next source repair
  and its production-shaped failure controls remain within this existing lane.
- Normal-hook19-workspace/205-binding closure is proposal-only; current compiler
  expects17. No accepted plan/apply/readback, shared/SDK output, actual compiler,
  17 integrated service cases, normal-hook commit or installation acceptance.
- Fresh signed-in Asimtop readback confirms existing MemSys project
  61c5af8e-6d33-4a11-969c-cd2a40168e75, planned/nonarchived. Rendered overview
  says reference links only. Board12 binding/import remains0; Authorize stays
  human-only and is not requested before installation is actually ready.
- Desktop/tailnet5113 health22:40:21/22 UTC ok on SAME e226. Live-runs query0;
  latest10 runs8 succeeded/2 acpx_turn_failed. ASI-64/62 saved state done, while
  ASI-53/55 remain blocked; actual artifacts/benefit not independently accepted.
  Chief/CTO notified without credentials, log bodies or new run/provider calls.
- RAM96.627% at22:38:46 UTC exceeds90%. No heavy starts, app/process stops,
  route/upgrade changes, new branch/worktree/PR or public write. Preserve other
  owners' PP169/MS883 finishing priority and unresolved publisher outcomes.
- Original mixed index and private candidate index/ref unchanged on readback.
  Local checkpoint/comment draft retained for private#1620; GitHub comment not
  delivered because its writer's descendant no-popup qualification is pending.
  Source30/failure receipts and reusable private windowless note are retained.
  See [current checkpoint](doc/evidence/project12-qualification-delta-20261013.md).

- Existing Asimtop ASI-53/ASI-55: bounded redacted run/log readback22:55 UTC
  establishes Claude Summarizer session-quota exhaustion at both historical
  attempts. Complete2788B responses match stored SHA256; current quota remains
  unprobed. No retry/provider wake or adapter/model/configuration change.
  Private receipts retained under existing#1620; runtime owner/CTO notified.

- Paperclip #129 / private#1620: exact autoInstallPeers:true phase successor
  helper2070F07A/suiteB860CA41 now prepared and independently source-reviewed;
 51casesUNRUN. Final plan-only callerC8B886E8 source reviewed, AST0/max118;
  actual WhatIf0/nochild. Source51 admission23:05:22 UTC refused96.803% RAM
  BEFORE any native Job. No accepted plan, apply, build or installation follows.
  Original/index/ref pins unchanged; same e226 desktop/tailnet5113 healthok
 23:07:12/13 UTC. Resume source51 when own fresh90% gate permits, then plan;
  resolve full19 closure before binding apply. No new branch/worktree/PR/public
  write, foreign stop, provider wake or Authorize. All imports remain0.

### Superseding private delivery/admission checkpoint — 23:48 UTC Oct13

- Existing private agent-settings#1620 tracking was delivered by Chief through
  the supported connector: comment6156820214,2680 characters. Root independently
  read back the saved body and private repository at23:38:58 UTC; no duplicate
  root write. This supersedes the earlier undelivered MATERIAL STATUS label,
  not normal-hook/commit/source-publication or installation acceptance.
- Second source51 admission23:35:40.1092055 UTC refused91.100301% RAM against90%
  before Common import/native creation; childfalse/cases0. ReceiptC8FB38EA...99B286.
  All51 remain UNRUN; old30 passes do not qualify the successor or full plan.
- Desktop/tailnet5113 health23:33:58/59 UTC remained ok/authenticated/private on
  same e226, boot unchanged. No restart, route or configuration change.
- Company-delivery sidecar independently verified exact ASI-64/62 run/company/
  agent tuples and succeeded/exit0/completed metadata at23:47 UTC. Bounded saved
  summary prefixes were captured; no output revision, attributed deliverable or
  consumer acceptance was established. ASI-64 prefix contains a skills-context
  warning. Document routes include unredacted bodies and have no metadata-only
  option; protected documents/#1624 bundles stay held with their original owner.
- Historical ASI-53/55 complete API log hashes remain valid. Logical local_file
  can fall back to a configured mirror; physical file presence/source is unknown.
  Root neither altered nor deleted originals. Zero mutation counters describe
  explicit root requests, not all server bookkeeping or other owners' activity.
- Private receipts and existing #1620 connect these gaps to the owning queue.
  Finish source51 and full19 closure before apply/install. Project12 binding,
  consent and live imports remain0; Authorize stays human-only after readiness.
