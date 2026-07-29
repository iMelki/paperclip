# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

- Isolated Vitest children from Git hook-local repository state so nested
  temporary repositories and linked worktrees cannot inherit the committing
  repository's index. Added a foreign-worktree regression test and line-scoped
  `gitleaks:allow` annotations for 21 reviewed upstream test fixtures while
  retaining the pinned, fail-closed staged scan.
- Added company-scoped, caller-independent plugin webhook tenancy; exact
  company filters across dashboard deliveries, job-run errors, and logs; and
  atomic host-owned trusted-loopback policies with literal-address,
  method/path, encoded-alias, empty-wildcard, and no-redirect enforcement.
  Updated the UI, CLI, SDK, and OpenAPI contracts to carry the same company
  scope.
- Replaced an iteration-counted custom-image terminal WebSocket test wait with
  bounded asynchronous polling so native-Windows validation does not fail
  before the authenticated server path reaches the SSH connector.
- Prepared the owned fork for the current upstream `master` at
  `ca92f727c5f7e4a6e5d23d05fef188bee9066b81`, retaining iMelki governance,
  pinned secret scanning, and the Windows runtime layer while adopting the
  current Tool Gateway, ACP, Smoke Lab, plugin, execution-policy, recovery,
  routines, and portability architecture.
- Made Codex approval/sandbox bypass opt-in, added structured sandbox,
  approval, network, profile, and user-config controls, rejected conflicting
  raw adapter arguments, and emitted secret-free effective configuration
  metadata for run receipts and diagnostics.
- Retired the fork's prototype OpenAPI exporter in favor of upstream's
  schema-backed OpenAPI route and CLI/API surface.
- Hardened Windows validation and cleanup around Git-for-Windows shell paths,
  sandbox asset transfer, plugin build freshness, Vitest diagnostics, local
  service process trees, and graceful-then-forced embedded PostgreSQL teardown.
  The stable Vitest runner now transports its exact serialized-suite exclusion
  list through project configuration instead of overflowing Windows command
  line limits with one `--exclude` argument per test.
- Pinned Gitleaks `8.30.1` for staged local commits and complete-history pull
  request scans. The wrapper rejects a missing or mismatched binary, separates
  finding exit `2` from scanner/runtime failure, and redacts output. The PR
  verification chain now depends on the checksum-verified scanner job; 18
  reviewed historical synthetic/generated findings use exact fingerprints
  rather than path-wide exclusions. Repository-level required-check protection
  remains tracked in issue #13 because `master` currently has no protection
  rules and Actions capacity is not yet proven.
- Declared scanning-only secret handling in `.git-toolkit.json` and removed six
  inert `filter=secrets` attributes; the policy-aware repo-health audit now
  reports zero warnings while pinned/fail-closed Gitleaks remains tracked in
  issue #13.
- Changed new UI-created Claude and OpenCode agents to require explicit opt-in
  before bypassing permission prompts, while preserving legacy omitted-config
  compatibility and the explicit unattended onboarding path.
- Added a PowerShell pre-commit checker for Windows and made Husky prefer it
  when `pwsh` is available, preserving the existing shell checker as the
  fallback path.
- Confirmed the modernization wave-3 governance baseline is present with a
  clean repo-health grade apart from accepted local secrets-store warnings.
- Backfilled the governance baseline with secrets-filter coverage, `.env`
  hygiene, and issue templates required by the modernization audit.
