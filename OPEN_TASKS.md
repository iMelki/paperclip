# Paperclip Open Tasks

Last updated: 2026-08-08

This file is the durable local index for active `paperclip` issues.

## Active Issues

- [#41 - Retain callback-bridge launch ambiguity across adapter and heartbeat cleanup](https://github.com/iMelki/paperclip/issues/41)
  - Accepted remote callback launch ambiguity is not yet retained through the
    six direct adapters, ACPX partial-start cleanup, or heartbeat issue/
    environment/runtime release. Per-instance directories and low-level exact
    cancellation are necessary but do not supply a restart-safe run fence.
    The checkpoint therefore rejects every production remote callback-backed
    direct or ACPX execution, attended
    or unattended and over SSH or sandbox, before any launch event, manifest,
    runner call, process, or provider dispatch. Direct adapters throw
    `PAPERCLIP_CALLBACK_BRIDGE_DISABLED`; ACPX returns a terminal
    `phase=preflight` configuration result with the same code. Malformed
    non-null target input fails with `PAPERCLIP_EXECUTION_TARGET_INVALID`
    instead of falling back to local execution. There is no production
    override; only the exact module-owned capability issued while
    `NODE_ENV=test` passes the application/high-level adapter seam. The
    exported low-level server
    primitive remains reachable for protocol research tests and is not a
    production-safe bypass; a static call-site allowlist must prove that the
    gated seam is its only application caller. Keep this default-off gate until
    run/adapter/instance/nonce manifest, durable lifecycle event, retry-safe
    reconciliation authority, heartbeat release guards, terminal-ack adoption,
    and host-loss tests all pass. Never replay or release from missing in-memory
    state. Focused evidence is green for the frozen low-level protocol (41/41),
    all six direct remote-adapter suites (67/67), the execution-target suite
    (53/53), and the heartbeat configuration-fence matrix (4/4). Full ACPX is
    degraded: successive broad runs ended 92 passed / 2 failed / 4 skipped,
    93 / 1 / 4, and 88 / 6 / 4. The three isolated timeout rows passed alone,
    but the final broad run first retained an accepted session because terminal
    reconciliation was not proven and then hit five later timeouts. All timeout
    relaxations trialed for those three observed rows were reverted; an earlier
    separately justified Windows platform budget remains elsewhere in the
    suite. Diagnosis proved that the Windows Git-Bash fixture mixed MSYS shell
    and native Node pid namespaces, so it cannot authoritatively attest
    process-tree custody. The local runner no longer advertises that custody on
    Windows. Thirty real runner-backed lifecycle rows now skip only on Windows
    and remain mandatory on Ubuntu CI; deterministic preflight, parser, gate,
    controller, and local behavior tests continue to run on Windows. The final
    truthful Windows ACPX receipt passed 67 and skipped 34, including four
    pre-existing platform skips. Preserve the earlier red receipts under
    #20/#41. The ACPX test harness now assigns every implicit-cwd execution a
    stable, registered temporary workspace for that test and guards the
    invocation checkout's `.claude/settings.local.json` bytes before and after
    every row. The final focused run left both previously generated checkout-
    local settings files byte- and timestamp-stable; those existing untracked
    files remain preserved for owner classification rather than being deleted
    or staged. This fixture correction does not satisfy the Ubuntu lifecycle,
    restart, residue, or release gates. The green 131/10/0 workspace-runtime
    receipt covers local test custody only and does not satisfy a callback-bridge
    adoption gate. Production unattended remote mutation remains NO-GO under
    #41.

- [#31 - Bug: refresh heartbeat MCP fixture after catalog-only authorization hardening](https://github.com/iMelki/paperclip/issues/31)
  - The positive heartbeat fixture now includes the active catalog entry while
    negative coverage still excludes uncataloged connections and protects
    bearer material. Close only after the normal repository validation hook
    and pushed-SHA readback are green.

- [#29 - Finish coordination claim idempotency and lease credential lifecycle](https://github.com/iMelki/paperclip/issues/29)
  - Migration `0197` now converts the experimental plaintext lease credential
    column to a unique SHA-256 hash and adds a company-scoped, 72-hour claim
    idempotency ledger. Focused schema, token, and real embedded-PostgreSQL
    migration tests are green. Keep the issue open until the claim transaction
    implements atomic same-key replay/different-payload rejection, bounded
    expiry cleanup, fencing, and a reviewed token-rotation or encrypted-replay
    design. Before any write route, every lease/participation reference must use
    a same-company composite foreign key and an embedded-PostgreSQL test must
    prove that a foreign-company reference is rejected by the database itself;
    the current single-column references are only an observe-only foundation.

- [#28 - Add authenticated, contract-truthful task coordination authority](https://github.com/iMelki/paperclip/issues/28)
  - The first read foundation is company-authorized before detail loading,
    company-scoped throughout, pinned to the canonical Projects Ops contract,
    and explicit about unavailable Git, process, output, placement, and control
    evidence. Cross-company collection/detail races fail closed, fallback task
    identity is collision-resistant across companies. Observer responses must
    omit exact placement and Git working-state evidence; exact placement is
    limited to board or assigned/actively participating agents. Expired or
    ambiguous active leases must never be projected as current scope. Claim,
    heartbeat, release, and control-intent write APIs, fencing,
    path canonicalization, stop evidence, and takeover remain open; observe
    mode must continue until those gates pass. The company collection is now
    bounded before projection (default 50, maximum 100, maximum offset 10,000),
    strictly validates limit/offset, orders deterministically by updated time
    plus id, and batches each related table once instead of querying every root.
    Nested rows are capped with explicit truncation drift; incomplete lease
    history withholds all mutation scope. High-fanout coverage proves the fixed
    seven-query shape, bounded 200-instance projection, and linear membership
    checks. Child/work-unit truncation also makes task-wide lease authority
    incomplete, because an omitted child can hide a lease; every mutation scope
    is therefore withheld even when returned lease rows are below their own
    cap. Projected remote URLs remove userinfo, query, and fragment values.
    Paperclip
    coordinates desired state, claims, attempts, leases, and control intents and
    projects verified observations; it never replaces the definition-owned
    native journal's cursor/checkpoint/replay authority or backend accepted-task
    authority. Reconcile both before replay, and never treat a Paperclip outage
    as replay authorization.
  - The coordination WIP is now reconciled with current `dev` without rebasing
    or discarding either line of work. The read model remains observe-only: no
    claim/control write route, unattended controller, or Paperclip-owned native
    cursor authority has been enabled. Release still requires a reviewed PR,
    exact-head hosted checks, and the #29 write-authority gates.
  - Workspace-runtime startup now registers the exact child/claim before custody,
    releases provider execution only after kernel custody plus accepted-child
    checkpointing, retains the claim through readiness commit, and passes the
    active claim nonce through restart-adoption identity refresh. The isolated
    workspace-runtime suite is green at 131 passed / 10 skipped / 0 failed in
    206.82s with zero suite-root survivors. This is custody/readiness evidence
    only; it does not enable a claim/control write route or unattended execution.

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
    open until the fresh complete-suite receipt is green with zero surviving
    fixtures. The 2026-08-03 normal coordination hook failed four DB tests and
    left nine new Postgres candidates with zero new listeners; its wrapper also
    self-contaminated the before count, so the canonical probe must exclude its
    own harness/ancestor identities. Exact process/listener-delta proof remains
    required. The follow-up runtime-service
    repair now persists process-group identity before readiness, retains live
    or unproven descendants across natural exit and restart, treats persisted
    PID/group/registry identifiers as observation-only until a stable process
    birth identity exists, and extends that fail-closed boundary across
    heartbeat cancellation, shutdown, orphan reaping, and source-resolved
    recovery. The standalone `dev:stop` and `scripts/kill-workspaces.sh`
    controls likewise refuse to signal or discard evidence for a live or
    unproven persisted-only record. Follow-up fixes keep an unprobeable Windows
    process tree—including the production null-process-group shape—when a dead
    wrapper may still have live descendants in needs-human state. CIM lineage
    snapshots are advisory: an unobserved intermediate can spawn a grandchild
    between samples, so `taskkill /T` plus root exit never confirms a Windows
    tree stop without a launch-time Job Object or equivalent kernel receipt.
    Cross-platform orphan/restart,
    lost-handle cancellation/recovery, standalone-control, and descendant-
    survival regressions cover the boundary. Database restore's no-`psql`
    fallback also streams canonical COPY sections through one native session
    with backpressure and fail-closed parsing. The full normal hook plus an
    uncontaminated zero-survivor process receipt remain the release gates. The
    second no-bypass hook passed 327 files / 3,367 tests but added three more
    Postgres candidates with zero listeners; no cleanup or signal was used.
    The third hook reached the adapter layer and exposed detached test-wrapper
    leakage. Exact process identities reconciled 27 wrappers and 27 launchers,
    moved their 26 temporary roots to the Windows Recycle Bin, and verified
    zero remaining candidates. The repaired source-only adapter matrix passes
    322 tests with 25 skips across 20 passing and one skipped file in
    180,071.6 ms, with patch/config bytes unchanged and process-session
    candidates 0→0. A fresh complete hook must reproduce zero survivors before
    #20 can close. The final safety audit also found and repaired three
    fail-closed gaps: only `ESRCH` now proves PID/group absence, process group
    `1` is never probed or signalled as `kill(-1, ...)`, and unresolved own-
    group identity cannot authorize a historical group. Once group scope is
    selected, TERM or forced-kill failure never downgrades to PID-only success;
    identifiers outside Node's positive int32 range are rejected without a
    syscall. Focused Windows tests pass 6/6 and Ubuntu-24.04/WSL passes 11/11
    selected cases (119 unrelated cases skipped). The later 2,566,059ms hook
    passed 3,378 general-server tests with nine skips before codex-local failed;
    exact cleanup stopped its five identity-matched orphan workers, cleared
    eight inherited listener rows, and recycled only their five linked database
    roots while preserving the real port-5432 service. The commit receipt missed
    those listener rows because Windows attributed them to dead parent PIDs;
    post-run accounting must join recorded parent identities and postmaster
    ports instead of filtering only by currently live candidates. Dev-runner
    generation launch now uses an exclusive append-only claim journal whose
    exact header is durable before spawn and whose accepted child identity is
    appended and fsynced before publication. Release requires exact,
    generation-matched registry readback; raw registry writers/removers acquire
    a distinct guard in the same claim namespace. Both release paths preserve
    retry state across post-rename failures, and a premature asynchronous
    generation release can be retried after valid publication. Windows focused
    lifecycle/registry coverage passes 45 tests with five POSIX-only skips;
    Ubuntu-24.04/WSL passes all 37 core cases, including post-rename fsync retry.
    Server TypeScript is clean. A targeted workspace rollback test reached its
    intended retained-claim assertions but final cleanup refused the expected
    `untrusted_identity`; no matching child remained live, and the exact
    evidence roots are preserved at
    `%LOCALAPPDATA%\Temp\paperclip-runtime-control-rollback-VFP9fd` and
    `%LOCALAPPDATA%\Temp\paperclip-runtime-control-rollback-home-UPv21H`.
    They must not be deleted or signalled without a separate identity-safe
    reconciliation. Those historical evidence roots remain preserved. A later
    isolated workspace-runtime run passed 131 / skipped 10 / failed 0 in 206.82s
    and left zero survivors in its own test root; the complete repository hook/
    global process-delta receipt remains open.
  - The 2026-08-08 bridge investigation found additional false-success and
    identity-reuse paths. Git-for-Windows `$!` and the native parent pid are
    diagnostic observations only. Callback stop authority is the exact server
    birth identity plus its instance nonce and cooperative cancellation
    acknowledgement; a parent process is never signalled or required to exit.
    Same-nonce evidence with any conflicting birth field is preserved and fails
    closed. ACP process-session stop rejects when stdin-end or wrapper-exit proof
    is missing, awaits an in-flight event poll, and refuses to return success
    while exact tree custody or retained-resource release is false. Windows
    parent-directory power-loss durability and the #41 restart-safe lifecycle/
    heartbeat fence remain open adoption gates. The frozen post-review
    workspace-runtime cohort is now final at 131 passed / 10 skipped / 0 failed
    in 206.82s, with zero suite-root survivors. The complete repository hook and
    uncontaminated global process receipt remain release gates. ACPX test
    executions without an explicit
    cwd now receive one registered per-test temporary workspace, and a suite
    guard rejects any checkout-local Claude-settings mutation. Two settings
    files generated before that repair are preserved untracked for owner
    classification; they are excluded from the checkpoint commit. One P2 remains
    in the general lifecycle path: `stopRuntimeService` is not yet single-flight,
    so simultaneous stop/reset/rollback callers can enter termination/
    finalization twice. Add a per-service in-flight stop promise plus concurrent
    success/failure/retry regressions before #20 closes.
  - The two company import/export E2E cases now skip explicitly on Windows and
    remain mandatory on Ubuntu CI. Repeated focused runs showed that the
    long-lived PowerShell Job custodian could not return a stable terminal
    receipt on this host; retaining a red or advisory cleanup claim would be
    misleading. The fixture's synthetic Claude agent is now unassigned, which
    prevents assignment-triggered provider work during this archive-only test.

- [#22 - Make complete validation and package builds Windows-portable](https://github.com/iMelki/paperclip/issues/22)
  - The portable Node filesystem helper, validated direct package-manager
    entrypoint, native path assertions, timezone-stable UI fixtures, dependency
    scan boundary, and current package-build assertions are implemented. The
    final audit also found remaining host-side bare npm/pnpm executions,
    POSIX prepack/postpack pairs, and missing native-Windows CI coverage; finish
    those canonical resolver/lifecycle consumers before the fresh full matrix,
    typecheck, build, and representative pack readback. The 2026-08-03 normal
    hook also reproduced four sandbox fallback sync-in failures where
    `/usr/bin/sh` received native Windows paths, plus local/CI divergence in the
    installed `@pierre/diffs` version. Command-managed upload paths reject raw
    POSIX and Windows traversal components before normalization, but the cwd
    check is still lexical and does not prove symlink/junction containment;
    realpath-aware confinement remains open. Repo-managed `bash`/`sh`
    provision commands also reuse the resolved Git shell on Windows instead of
    allowing a nested bare `bash` lookup to select WSL and reinterpret an MSYS
    path; the previously failing worktree provision/reattach cases now resolve
    the source script through one shell namespace. Valid UNC paths convert to
    double-slash shell paths, while malformed and device-namespace UNC forms
    fail closed; focused command-managed coverage includes spaces, apostrophes,
    confinement, and prefix escapes. The workspace-diff imperative hook now
    passes the `editorOptions` and non-editable `edit` values required by the
    installed `@pierre/diffs` 1.3.5 API. The normal hook does
    not include `pnpm build`. The second hook's only suite failure exposed a
    missing emitted-test JSON asset; the portable server build now copies the
    pinned contract into `dist`, and source/built regressions pass 5/5 and 4/4
    with matching schema hashes. Adapter test discovery is now source-only and
    serial, Git-for-Windows hooks prefer native `tar`, local Git fixtures use a
    line-ending-stable checkout, Windows command shims are resolved explicitly,
    and sandbox queue publication uses a same-directory atomic rename. The
    source-only adapter matrix is green at 322 passed / 25 skipped with no
    process-session delta. The explicit monorepo build is also green in
    67,031.5 ms with staged bytes unchanged and no new process candidates. The
    repeated full hook, native Windows matrix, and provider-native atomic
    realpath confinement remain release gates. The fourth no-bypass hook
    exposed eight server fake-sandbox failures caused by a hook-wide
    System32-first PATH selecting Windows `find.exe` for POSIX syntax. Native
    host tar selection is now scoped to System32 `tar.exe`; five fake runners
    use the canonical Git shell resolver, and hermetic Claude config/home state
    avoids host-profile coupling and overlong instance paths. Under the same
    hostile PATH, 61/61 server cases and 35/36 adapter cases (one prerequisite
    skip) pass with byte-stable input/output. Codex-local now mirrors source-only
    serial discovery, uses the Git shell in native Windows fixtures, applies
    native temp-path and child-termination assertions, and assigns unique ACP
    run identities with bounded cleanup. Its full source suite passes 222 with
    nine legitimate skips across 23 files in 117.69s. Because Node mode bits do
    not express NTFS confidentiality, remote Codex home staging and same-volume
    copy-back now create their randomized roots atomically with a protected .NET
    `DirectorySecurity` descriptor before the paths become visible. The helper
    rejects a parent that grants `DELETE_CHILD` to any untrusted SID and
    revalidates parent/child identity after secret population. Copy-back creates
    the OAuth child only below that private root and
    keeps it owner/SYSTEM/admin-only through the merge decision. Only an
    accepted same-identity, strictly newer credential receives the final Codex
    sandbox-reader ACE, via one complete protected DACL operation plus identity
    and exact-policy readback before rename. It removes only the exact child plus
    an empty directory with
    bounded fail-loud retries. Failed staged-home cleanup surfaces the original
    error and unproven residue together. Exact production readback and DACL
    tests prove the atomic path, long run-id compatibility, and only the intended
    host principals (plus the independently resolved standard Codex read group
    on the final credential). A Windows restricted-token regression proves the
    rejected stage unreadable before acceptance and the final credential
    readable only after the policy transition. Keep
    #22 open for provider-native realpath/link confinement and the broader native
    Windows matrix. All production remote ACP targets remain hard-disabled:
    runner-backed and runner-less sandboxes plus SSH/non-sandbox targets fail
    before workspace materialization, staging, provider execution, or local ACP
    fallback. Malformed non-null remote intent also fails closed instead of
    degrading to local. Implicit/default remote execution stays on CLI, while explicit
    remote `engine=acp` fails closed. An injection-only test seam exercises the
    inert runner-backed controller. Enabling a real provider requires callback-
    bridge process-tree custody, a two-phase durable cleanup acknowledgement,
    and restart-safe reconciliation. Numeric PID-file stop, in-memory registry
    deletion, or direct-child exit cannot satisfy that gate. Ubuntu/WSL core
    lifecycle tests are green, but six `dev-service` CLI subprocess cases cannot
    be counted as Linux evidence in the shared checkout because its
    cross-platform `node_modules` contains an esbuild host/binary version
    mismatch (`0.28.1` host versus `0.27.3` Windows binary). Re-run that CLI
    cohort from a native Linux dependency installation under #22; do not weaken
    assertions or treat the environment mismatch as a product pass.

- [#19 - Make headless onboarding and doctor failures automation-safe](https://github.com/iMelki/paperclip/issues/19)
  - Implemented explicit config-only `onboard --yes --no-run` behavior and
    nonzero failed-doctor process status. Close after the committed CLI is used
    to materialize and diagnose the loopback-only factory instance.

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
