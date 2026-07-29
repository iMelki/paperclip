# Paperclip Open Tasks

Last updated: 2026-07-29

This file is the durable local index for active `paperclip` issues.

## Active Issues

- [#23 - Tool Gateway catalog and health omit configured static headers](https://github.com/iMelki/paperclip/issues/23)
  - One fail-closed header policy now governs gallery discovery, health, and
    execution. Static non-secret headers are delivered without allowing caller
    config to override the gallery URL, quarantine, managed credentials, or
    MCP protocol headers. Close after the complete matrix and a live GitHub MCP
    read-only catalog probe succeed on the committed runtime.

- [#21 - Allow company import to preserve explicit Process adapters](https://github.com/iMelki/paperclip/issues/21)
  - Add an explicit preserve-adapters import mode so a portable company export
    can retain deterministic Process validators. Until then, use the reviewed
    high-level dry run followed by the raw import API without adapter overrides.

- [#20 - Reap Windows test process trees and remove load-order timeout flakes](https://github.com/iMelki/paperclip/issues/20)
  - All 125 embedded-PostgreSQL hooks that previously overrode setup with an
    explicit 20-second bound now use one shared 60-second Windows / 20-second
    non-Windows constant, with an AST regression guard. Runtime-service teardown
    has focused process-tree reaping coverage; keep this issue open until the
    fresh complete-suite receipt is green with zero surviving fixtures.

- [#22 - Make complete validation and package builds Windows-portable](https://github.com/iMelki/paperclip/issues/22)
  - The portable Node filesystem helper, validated direct package-manager
    entrypoint, native path assertions, timezone-stable UI fixtures, dependency
    scan boundary, and current package-build assertions are implemented.
    Close after the fresh full matrix, typecheck, and build read back green.

- [#19 - Make headless onboarding and doctor failures automation-safe](https://github.com/iMelki/paperclip/issues/19)
  - Implemented explicit config-only `onboard --yes --no-run` behavior and
    nonzero failed-doctor process status. Close after the committed CLI is used
    to materialize and diagnose the loopback-only factory instance.

- [#16 - Configure the Assistants day-0 software factory](https://github.com/iMelki/paperclip/issues/16)
  - Configure the local company, goals, budgets, role agents, execution policy,
    routines, workspaces, Tool Gateway, Smoke Lab, deterministic validator, and
    secret-scrubbed export for the MCK golden path.

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
