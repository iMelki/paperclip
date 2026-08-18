# Changelog

## Unreleased

- Prevented the local ACP process-session proxy from forwarding late stdin
  events after a remote terminal frame has already ended its socket (#59).
  The exact PR #66 hosted shard exposed the race as
  `ERR_STREAM_WRITE_AFTER_END`; the proxy now ignores writes once it is
  exiting, destroyed, or writable-ended, and the owning streamed-order test
  mechanically verifies that guard in the generated proxy. The same real hook
  also exposed a cluster of POSIX-only `0600`/`0700` assertions, a bare `sh`
  fixture, and literal `/` temp-path prefixes in the Codex credential tests;
  Windows now retains the functional credential/rotation assertions, POSIX
  continues to verify permission bits, shell-backed fixtures use the reviewed
  Git-for-Windows resolver, and temp paths use native joins (#22).

- Corrected the deterministic pre-push baseline for existing topic branches
  after they merge current `dev` (#73). The old path diffed the remote topic tip
  to `HEAD`, so a real PR #66 push re-selected five already-published `dev`
  files and failed on their missing local siblings. Every content update now
  validates the configured destination, resolves its advertised `dev`, requires
  that object to be an ancestor, and tests the final `dev..HEAD` tree. The
  Gitleaks caller deliberately retains the exact outgoing
  `remote-topic..HEAD` commit range. A deliberate old-baseline regression failed
  for the exact A-versus-C range mismatch; the restored planner/secret suites
  passed 22/22 and the real hook passed all exact suites without a bypass.

- Extended the adapter/runtime `git push` gate repair after adversarial review (#76, #77).
  `scripts/check-no-git-push.mjs` swallowed three filesystem errors
  (`statSync` on a scan root, `readdirSync` mid-walk, `readFileSync` on a
  file), so an unreadable or renamed tree produced exit 0 and the message
  "No unapproved `git push` invocations found" having scanned zero files.
  Renaming the four scan roots was enough to clear an offending file that was
  still on disk. Unreadable paths now exit 2 naming the path and errno, a scan
  of zero files is an error in its own right, and the success line carries a
  non-zero denominator. Reopened evidence in `bf81b90e` then proved three
  working bypasses: one renamed required root still passed, and a committed
  mode-120000 directory symlink silently dropped its entire target subtree
  because its directory entry described the link rather than the target,
  and `.mts`/`.cts`/`.jsx` files were never scanned. Follow-up review also found
  tracked paths hidden from the visible working tree. Required roots now fail
  when absent or empty; every tracked in-scope path must be physically observed
  or deliberately classified with normal index state; skip-worktree and
  assume-unchanged byte-substitution attempts reject before content scanning;
  and symlinks, junctions, tracked generated/cache
  directories, unknown entry kinds, encodings, and undeclared file types fail
  integrity. Declared untracked package-manager/build directories stay outside
  the pushed-tree denominator. The language-aware scanner covers JavaScript,
  TypeScript, shell, PowerShell, Python, and configuration sources without
  treating URLs or regex literals as comments. Ambiguous data languages,
  including PowerShell here-strings, cannot grant exemptions from inside
  multiline strings. Executable substitutions inside expandable PowerShell
  here-strings remain visible to the command gate; only column-zero PowerShell
  closers end a here-string. Every shell heredoc body and exact delimiter line
  remains scan-visible even when its delimiter is quoted; this intentionally
  review-gates command-shaped literal data so a false heredoc classification
  cannot hide a following command. Exact delimiters still receive quote removal
  across ordinary/ANSI-quoted fragments and LF/CRLF continuations to end lexical
  state, while unsupported forms remain conservative. Arithmetic `<<` stays in
  arithmetic state rather than creating
  a false heredoc that could hide a following command. Arithmetic
  that contains a quote, expansion, or escape keeps the remaining source
  conservatively scan-visible instead of guessing at shell parsing, and legacy
  `$[...]` arithmetic uses the same fail-closed treatment. The gate runs in both
  platform pre-push callers and in PR CI for `dev` and `master`.
  The deterministic pre-push planner applies the same normal-index proof to
  the whole repository, so substituted UI, script, package, or test bytes
  cannot be executed in place of the pushed HEAD. Final review hardening aligns
  lexical blanking with JavaScript's UTF-16 offsets, requires the stable-runner
  regression in PR policy, retains native PowerShell stderr/status, and cleans
  POSIX temporary artifacts on HUP, INT, and TERM.

- Replaced the floating React Doctor `npx` hook invocation with a local-only
  resolver, minimized child environment, and normalized fail-closed receipt.
  The current branch intentionally remains incomplete until a separately
  reviewed dependency pin and lock update is approved. Until then the hook
  reports an explicit disabled state (exit 2); analyzer failures still block
  commits. No fallback or network bootstrap is permitted.

All notable changes to this repository should be recorded here.

## Unreleased

- Fixed native-Windows adapter-utils execution by moving the process-session
  payload out of the Git-for-Windows `sh -c` argument, using Node-native file
  copying, resolving script wrappers through Node, and making shell discovery
  support PATH-derived, per-user, and Scoop Git installs with a clear failure
  when no complete Git shell is available. Process-session stdin and EOF writes
  are now ordered, and cleanup waits for proven wrapper termination before
  removing the remote session or workspace. Gemini version detection now uses
  the shared trusted Windows shim launcher, supports install paths with spaces,
  downgrades pre-0.33 CLIs to `--experimental-acp`, and reports probe failures
  before retaining `--acp`. Adapter-utils managed-runtime host archives now
  bind to System32 `tar.exe` on Windows so Git Bash cannot reinterpret
  drive-letter paths as remote archives. The environment transport remains
  bounded; #64 tracks reducing or replacing the oversized ambient-env payload.

- Replaced the unsupported fork Dependency Review call in the trusted PR-review
  workflow with a fail-closed fork policy: dependency manifests, lockfiles, and
  package patches now require the maintainer-only `dependency-review-approved`
  label. Non-fork repositories retain GitHub's native Dependency Review action,
  and every review executes the trusted PR base commit rather than hard-coded
  `master` content.

- Replaced the all-or-nothing/uncapped-related pre-push suite with a real Git
  update parser and runner-aware exact selection. Changed tests and deterministic
  siblings run under Node or Vitest; missing coverage fails closed; hosted-only
  changes require a topic PR. A push must be one pristine checked-out HEAD, new
  branches resolve the actual destination's advertised `dev`, and outgoing
  secrets use its exact base-to-head range. Git's literal `HEAD` local-ref form
  from an explicit `HEAD:topic` refspec is accepted without weakening the OID or
  pristine-worktree binding. PR CI now covers `dev` without adding `push: dev`
  and scans only the PR range rather than known-red full history. Both platform
  callers remove their temporary update artifacts after every outcome while
  retaining the consolidated log; the POSIX caller also removes per-step files,
  supports isolated caller-test logging, and the PowerShell caller streams long
  step output as it arrives. Exact Vitest paths now run independently so an
  included suite cannot mask a second path excluded by its project config;
  capped and uncapped pre-commit related selections also run every selected
  suite in a separate Vitest process so coordinator-owned environment and mock
  state cannot leak across otherwise independent suites. Linux-only Bubblewrap
  characterization cases now skip unsupported hosts while portable parsers
  continue to run on every platform;
  option-shaped missing values and non-array selector inputs reject before work,
  and only a real non-ancestor Git result is translated into the advertised-dev
  ancestry message while infrastructure failures retain their cause.

- Normalized release-package discovery directories to forward-slash manifest
  paths, with a Windows-separator regression, so release-map validation does
  not report every package as missing on native Windows.

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
