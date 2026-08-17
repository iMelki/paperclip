# Paperclip Open Tasks

Last updated: 2026-08-18

This file is the durable local index for active `paperclip` issues.

## Recently Closed Issues

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
    second-review hardening and portable evidence are complete locally, with
    the next exact-head hosted readback still pending.

## Active Issues

- [#73 - Push lockout: the exhaustive pre-push gate rejects every push](https://github.com/iMelki/paperclip/issues/73) — **reopened after a real existing-topic push**
  - PR #78 replaced the uncapped related sweep and merged as `9983a44a`, but a
    PR #66 push after merging that `dev` tip exposed one uncovered existing-ref
    path: the planner diffed the old remote topic tip to `HEAD`, re-selected five
    already-published `dev` files, and rejected them for missing siblings.
  - Commit `43011d50` resolves advertised `dev` for every content update,
    requires it as an ancestor, and tests the final `dev..HEAD` tree while the
    secret scanner keeps the exact outgoing topic range. Deliberate old-baseline
    proof failed for A versus C, focused planner/secret tests passed 22/22, and
    the real hook passed 31-project typecheck plus 35 Node and ten isolated
    Vitest suites. Exact-head hosted review remains the closing gate.

- [#77 - check-no-git-push extension allowlist is fail-open by omission](https://github.com/iMelki/paperclip/issues/77) — **local repair and proof complete**
  - The scanner now rejects every undeclared file type under its required roots.
    Only explicit declaration/document exclusions remain outside content scanning,
    so a newly introduced extension becomes a named integrity failure rather than
    disappearing from the denominator. A real scratch caller rejected the hostile
    unknown extension at exit 2, then passed after a hash-verified restore; hosted
    exact-head proof remains pending.

- [#46 - Make React Doctor hook execution reproducible and fail closed](https://github.com/iMelki/paperclip/issues/46)
  - Commit `124a48cc` removed the floating `npx react-doctor@latest` path and
    added bounded local resolution, minimized child environment, normalized
    receipts, timeout/termination handling, and negative-proof evidence. The
    quality gate remains explicitly disabled until React Doctor is declared in
    the manifest/lockfile and receives license, dependency-closure,
    offline/Windows/Linux, and authenticated-consumer qualification evidence.

- [#67 - CI never validates dev: pr.yml is scoped to PRs into master](https://github.com/iMelki/paperclip/issues/67)
  - Bootstrap prepared: PR CI covers `master` and `dev`, never `push: dev`, and a
    static gate fails if either branch disappears or a push event is added. The
    bootstrap PR launched and completed the full hosted matrix on two repaired
    heads. The policy now mechanically requires the stable-runner regression;
    read back the final repaired head before closing this issue.

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

- [#5 - Use relevant skills for market research, competitor analysis, and monetization planning](https://github.com/iMelki/paperclip/issues/5)
  - Goal: map competitors, ICPs, monetization options, and positioning for paperclip.

- [#6 - Design and build a landing page](https://github.com/iMelki/paperclip/issues/6)
  - Goal: define and implement a landing page with clear audience, value proposition, proof, and CTA.

## Recently Completed

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

- [#48 Expand UI/UX Awwwards report (2026-08-09) into practical tasks](https://github.com/iMelki/paperclip/issues/48)
  - Fleet-wide code-only audit scored this app 7.8/10 against the shared
    Awwwards rubric. Full report: `docs/uiux-awwwards-report-2026-08-09.md`.
    Scores are code-inspection estimates pending a Frontend Proof Bundle.
    Fleet rollup: iMelki/agent-settings#586.
