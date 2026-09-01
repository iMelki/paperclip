# Paperclip Open Tasks

Last updated: 2026-09-01

2026-08-25: [paperclip#95](https://github.com/iMelki/paperclip/issues/95) —
Windows factory start failed migrate (`42P07` / later `42703`) because the
Drizzle journal lagged the existing schema. Ledger repaired in `client.ts`
without wiping the factory DB. Start remains gated on a clean `dev` tree.

This file is the durable local index for active `paperclip` issues.

## Recently Closed Issues

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

- [x] [Projects Ops #117 - Enroll Paperclip in Repo Doctor](https://github.com/iMelki/projects-ops/issues/117)
  - The governed checkout now has an observe-only `on_demand` genome with four
    bounded authored-source sets, 3,246 selected files, two explicit generated
    exclusions, and no analyzer execution or quality authority. The direct
    invalid-reference proof failed closed as direct `invalid`/2 and shared
    `invalid_genome`/2, with private issue text withheld. The restored
    direct/shared plan resolution passed at 3,246 selected files and two
    exclusions. Agent Settings fixed the classification contract in
    `c91e70cc`; an invalid genome remains non-green and no analyzer ran.

- [#80 - Disposition matrix: extract, land, or retire preserved PR #45 without losing WIP](https://github.com/iMelki/paperclip/issues/80) — **no-loss census complete locally; reviewed delivery pending**
  - The protected local and remote-tracking source refs both still resolve to
    `7bae4af253dfd96ac8a4d44807b479bcece01865`; PR #45 remains an open draft.
    The generated manifest owns all four commits, 162 commit/path rows, 131
    unique historical paths, and 3,032 unified-zero hunks with zero unowned or
    unknown rows. Twelve hunks are already landed with exact named-commit and
    pinned-current-tree evidence; 936 remain selective-extraction candidates,
    2,084 require semantic re-derivation, including all 2,000 remerge-diff
    hunks. Those reconstructed-merge differences can contain meaningful manual
    conflict resolution, so none is called stale without path-specific proof.
    The focused generator suite passed 3/3
    and `--check` reproduced the evidence under
    `doc/evidence/pr45-disposition/`. No merge, wholesale cherry-pick, stash
    mutation, source-branch deletion, or evidence retirement is authorized.

- [#53 - Make coordination evidence and health fail closed](https://github.com/iMelki/paperclip/issues/53)
  - #82 is closed and is no longer a blocker. The remaining v2 contract is an
    additive presentation-only route with a persisted root coordination
    generation. `unassigned` is a non-authorizing sentinel; unknown,
    malformed, stale, or ownership-mismatched facts must stay non-positive and
    can never be projected as healthy. Existing v1 behavior remains untouched.
    The preserved PR #45/p53 commits are evidence inputs, not cherry-pick
    authority; implementation still needs its own migration, Ajv schema,
    route/service tests, and caller-shaped negative proof on current `dev`.

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

- [#84 - Clarify or restore the Greptile 5/5 merge gate](https://github.com/iMelki/paperclip/issues/84)
  - Decision implemented locally, pending reviewed delivery: Greptile is
    optional and must be marked N/A when unconfigured. CodeRabbit is primary;
    exact-head Cursor Bugbot/review is the documented fallback. CI and human
    review remain separate. The old 5/5 sentence failed the real policy test,
    and the restored policy passed 4/4.

- [#87 - Bug: onboarding shows Codex but persists Claude adapter](https://github.com/iMelki/paperclip/issues/87)
  - Implemented locally, pending reviewed delivery. A returning flow now updates
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
    for their exact reasons before byte restoration. Independent full-diff
    review is GO with no P0/P1. #105 owns opaque revision/CAS hardening and #107
    owns the accepted Wizard reduction follow-up.

- [#88 - Pending Codex hire approval redacts intentional empty API key and leaves agent stuck](https://github.com/iMelki/paperclip/issues/88)
  - Source, focused executable proof, and server typecheck are complete locally;
    real hooks and hosted delivery remain. Exact-empty plain bindings survive
    while non-empty and
    whitespace-only secrets remain redacted. Hire preparation is enforced at
    the service boundary, same-company pending baselines are required for
    restoration, approval/activation/reconciliation/budget writes are one
    transaction, and notification starts after commit. Standalone approvals
    apply icon, runtime config, default environment, and restrictive permissions
    exactly; request-revision and resubmit transitions use status predicates.
    Ambiguous bare `token`, camelCase private-key/secret/token credentials, and
    provider-prefixed request keys are redacted from actual pino output. The
    final camelCase set passed 15/15 after its deliberately broken control failed
    2 unit assertions and 1 production-pino canary. The prior post-review set
    passed 47/47,
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

- [#105 - Use server-owned adapter-config revisions for onboarding verification and CAS](https://github.com/iMelki/paperclip/issues/105)
  - P2 defense-in-depth follow-up from #87. Replace raw private-config
    expectation state with an opaque server-owned revision, and require that
    revision as an `If-Match`/compare-and-set precondition so a concurrent edit
    between GET, environment probe, and PATCH cannot be overwritten silently.

- [#106 - Reduce oversized onboarding and approval orchestration after the current delivery](https://github.com/iMelki/paperclip/issues/106)
  - Owns the exact-patch maintainability exceptions for the existing oversized
    agent routes, built-in/plugin-managed services, approval service, and Wizard.
    Review before the next substantive growth or by 2026-09-15.

- [#107 - Extract the onboarding step-4/5 controller before further Wizard growth](https://github.com/iMelki/paperclip/issues/107)
  - Dedicated Paperclip UI follow-up. Reduce `handleGiveHeartbeat` below 80
    source lines while preserving effective-config testing, PATCH/readback
    order, secret non-storage, and current Shadcn/Radix presentation. Review by
    2026-10-01 or before the next substantive step-4/5 change.

- [#63 - Shell-safety siblings: git-workspace-sync legacy quoter, bare-sh spawns, unguarded postUploadCommand](https://github.com/iMelki/paperclip/issues/63) — **SSH focused proof and adapter-utils typecheck complete; reviewed delivery pending**
  - PR #69 (squash `987700f91`, 2026-08-18) aliased `git-workspace-sync` to
    `shellQuotePath`, routed the six bare-`sh` test spawns through
    `resolveTestShellCommand`, and exported `quoteSandboxProvisionPath` /
    `buildSandboxRuntimeAssetExtractCommand` as the provision contract. The
    exact-head CodeRabbit review also fixed the `mkdir` parent derivation with
    `dirnamePortablePath` — the #36 defect class at the git-workspace-sync
    site. The current `dev` worktree re-exports the canonical `shellQuote`, and
    both SSH support detection and fixture startup now use the shell-free
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
    and the two focused suites passed 17/17. The ratchet now also proves
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
    outside this SSH-specific change. Exact-head hosted proof remains pending.

- [#47 - dev tip fails 2 Windows path tests — hook rejects all commits](https://github.com/iMelki/paperclip/issues/47)
  - Local repair complete. `remote-managed-runtime.ts` now treats its
    `localPath` as a host path and accepts either POSIX or Windows absolute
    forms while retaining POSIX remote sandbox paths. The two formerly failing
    Windows cases pass, the full related commit hook passed, and the next
    remaining gate is a fresh exact-head pre-push/hosted-CI run.

- [#62 - Windows: symlinks do not survive the tar create/extract round-trip in runtime asset sync](https://github.com/iMelki/paperclip/issues/62)
  - Open remote tar-transport follow-up. Not addressed by PR #66/#69; keep with
    the #47 remote-tar cluster.

- [#64 - Security: the ACP bridge payload forwards the whole host env to the sandbox provider](https://github.com/iMelki/paperclip/issues/64)
  - Open. The environment transport remains bounded per the PR #66 changelog
    entry; reducing or replacing the oversized ambient-env payload (and its
    unrelated-secret exposure) remains this issue's scope.

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
  - Gauntlet **21/21** (run 10, `f7a0160fc`, 2026-08-27): first-pass
    `/ASS/design-guide` rendered 16 capsules, `mainTextLen` 17664, empty
    `consoleErrors`. Receipt:
    `docs/uiux/browser-evidence-2026-08-27/gauntlet-run10-f7a0160fc.json`.
    #94 (six browser defects) and #89 (390 fine-pointer reflow) remain
    open and are not closed by this receipt.
  - 2026-08-28 carry: factory still `f7a0160fc` **21/21**. Awwwards **7.4**.
    Design-guide SVG fixed. Local UI commits `a384c4dc2` + `145720089` are
    **not** on origin. No issue close.
