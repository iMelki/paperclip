# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

- Bounded the POSIX runtime-service adoption fallback for #20: the `ps`
  command/parent-lineage walk now has a two-second total deadline and explicit
  child-process timeouts, with a regression fixture proving a non-returning
  `ps` cannot hold adoption indefinitely. The nine omitted upstream recovery
  tests remain a separate follow-up.
- Fixed the #20 workspace-busy retry handoff race: the source heartbeat run
  stays non-terminal until its `scheduled_retry` child is inserted and linked,
  so observers cannot see a cancelled run without its retry. Existing
  heartbeat-workspace-busy coverage now passes all 15 tests.
- Restarted the loopback-only `assistants-factory-win` instance from current
  `origin/dev` SHA `902118b6670642ba3111c20118949c9578d00ea4`; health, auth,
  backup, branch, and full-SHA provenance read back cleanly at
  `2026-08-08T16:45:58.856Z`.
- Completed the explicit catalog-review contract in the MCP E2E connected
  fixture (`reviewedCatalogEntryIds`) after draft discovery was correctly
  quarantined by the Tool Gateway policy. Paperclip CI run `31262062577`
  passes all required jobs and all three E2E shards. Tracked the separate
  asynchronous teardown FK/deadlock race as issue #42 rather than weakening
  quarantine behavior.
- Narrowed deterministic Validator context access to a running standard-trust
  Process-adapter heartbeat assigned to a direct child issue. The exception
  permits `issue:read` for that direct parent only, accepts either a null or
  run-owned checkout, and has negative coverage for Codex, terminal, low-trust,
  sibling, grandparent, cross-company, and comment access.
- Aligned the gallery-connection regression with Tool Gateway's mandatory
  pending-review posture: newly discovered gallery tools remain quarantined
  until the explicit finish/review step activates the selected catalog
  entries. This preserves deny-by-default behavior instead of weakening the
  production policy to satisfy a stale test expectation.
- Added an explicit `company import --adapter-strategy preserve` path for #21.
  Preview and apply receipts enumerate preserved executable Process agents,
  default imports retain the existing portable Process-to-Claude fallback, and
  selected/skipped agent handling no longer creates silent adapter overrides.
- Replaced Windows test cleanup's bare-PID assumptions with bounded,
  creation-time-identified process-tree reaping for #20. Embedded PostgreSQL
  fallback cleanup and CLI/runtime fixtures now prove exact ownership, retain
  reparented descendants, reject PID reuse, fail closed when identity cannot
  be established, and report before/after PID evidence without command lines.
  Load-sensitive nested-Git and runtime-reset checks retain finite 30-second
  and 20-second ceilings instead of failing at the previously observed edge;
  explicit dependency-directory globs also prevent tsx's Windows watcher from
  treating the compact brace form literally and restarting during dependency
  churn.
- Extended #23's static remote-MCP policy to reject high-confidence secret
  values even under benign header names, control/non-ByteString values, and
  unsupported policy versions before persistence. Tool Gateway response reads
  are now streaming and bounded, including chunked responses and early
  content-length aborts.
- Made Tool Gateway install-mode readback authoritative for factory catalog
  activation. `GET` and `PUT` install responses derive persisted
  `reachability_only` versus install-owned access, report separately owned
  app-profile bindings, and fail closed on partial or conflicting profile
  state so factory roles do not need a broad extra `app:<connectionId>`
  profile.
- Unified remote-MCP header resolution across gallery connection discovery,
  health checks, and Tool Gateway execution under #23. Versioned non-secret
  static headers now reach every protocol path, credential and MCP protocol
  headers remain authoritative, malformed policies fail before persistence,
  and audit/catalog evidence records names and collision decisions without
  storing header or credential values.
- Hardened native-Windows test lifecycle cleanup: all 125 embedded-PostgreSQL
  `beforeAll` hooks that carried the former explicit 20-second setup bound now
  use one shared, AST-guarded 60-second Windows / 20-second non-Windows policy.
  Failed or reset runtime services terminate their registered process trees,
  restart-adoption tests opt into process preservation explicitly, and
  stale-port fixtures reap the real listener PID. The workspace-runtime suite
  now records 100 passing tests (5 skipped) and exits with no surviving
  runtime-service fixtures; complete-suite proof remains under #20.
- Made the observed complete-validation paths Windows-portable under #22:
  a cwd-contained Node filesystem helper replaces POSIX `cp`, `rm`, and
  `chmod` across database, server, sandbox-provider, CLI, and Codex-adapter
  builds; packaged-artifact tests invoke validated JavaScript package-manager
  entrypoints through Node without shell interpolation, including
  metacharacter paths; path assertions use native separators; and
  local-calendar UI fixtures no longer assume the host runs in UTC. Stale
  package-build assertions now verify the portable helper, catalog scans skip
  dependency trees, Cases route tests cache their expensive application import,
  and workspace reconciliation accepts the observable `starting` to `running`
  service transition while preserving the 422 safety gate.
- Documented the current company-import adapter rewrite and the reviewed raw
  import API workaround that preserves deterministic Process adapters while
  issue #21 tracks a first-class preserve-adapters mode.
- Added `onboard --yes --no-run` for non-interactive config-only bootstrap and
  made failed `doctor` diagnostics return a nonzero process status, with
  focused regression coverage and automation guidance.
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
