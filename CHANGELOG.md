# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

- **[#80]** Turned the four preserved PR #45 WIP commits into a reproducible
  no-loss disposition manifest: 162 commit/path rows, 131 unique historical
  paths, and 3,032 unified-zero hunks with zero unowned or unknown rows. Exact
  named-commit/current-tree evidence distinguishes already-landed results from
  selective extraction and semantic re-derivation. Every remerge-diff hunk is
  conservatively assigned to semantic re-derivation/manual review because the
  reconstructed-merge comparison can contain meaningful conflict resolution;
  none is called stale without path-specific proof. The generator pins both local and
  remote-tracking preservation refs to `7bae4af2`, and explicitly forbids a
  wholesale merge/cherry-pick, branch deletion, stash mutation, or evidence
  retirement without separate authority.

- **[#63]** Replaced SSH executable discovery through interpolated
  `sh -c "command -v ..."` with a shared shell-free PATH/PATHEXT resolver, and
  reused the canonical shell quoter instead of keeping a second copy. The
  resolver mirrors Node's unset/empty PATH behavior, Windows environment-key
  selection, documented PATHEXT fallback, platform-specific path forms,
  file-type checks, and executable-access checks. Adapter-utils typecheck now
  invokes an AST gate first; its deliberately unsafe aliased shell/argv,
  named-import launcher, and zsh/composite-flag/`which` fixtures must make that
  exact caller exit nonzero,
  while passive text and the real SSH source remain accepted. ACPX/Gemini's
  separate `cmd.exe /c` probe stays tracked in #100.

- **[#88]** Preserved an intentionally empty plain API-key binding in hire
  approvals while continuing to redact every non-empty or whitespace-only
  secret. Hire payload preparation is enforced at the approval-service boundary
  for normal, built-in, plugin-managed, create, and resubmit paths; redacted
  values can be restored only from the same path on a same-company pending
  agent, and missing, changed, embedded-marker, cross-company, or non-pending
  baselines fail closed. Approval resolution, activation/creation,
  reconciliation, and budget persistence now share one database transaction,
  with notification attempted only after commit. Standalone approvals preserve
  icon, runtime config, default environment, and restrictive permissions;
  revision/resubmit updates use status compare-and-set guards. The confirmed
  Drizzle `params:` error-log path, provider-prefixed credentials, camelCase
  private-key/secret/token keys, and ambiguous bare `token` fields are redacted
  through the production pino configuration. The final camelCase negative
  control leaked its canaries and failed three assertions before exact
  restoration; the restored production-shaped set passed 15/15 and server
  typecheck passed through the task-owned resource/disk envelope.
  Historical-row migration, creation-time
  agent/approval atomicity, durable notification delivery, and broader
  structured error-context allowlisting remain tracked separately in #102,
  #103, #101, and #104.

- **[#84]** Replaced the stale mandatory Greptile 5/5 language with truthful,
  provider-specific review evidence. CodeRabbit is the primary automated
  review lane, exact-head Cursor Bugbot/review is the documented fallback when
  CodeRabbit is unavailable, and Greptile is explicitly optional/N/A unless a
  maintainer configures it. Hosted CI, automated review, and human review remain
  separate gates. A caller-shaped negative proof restored the legacy 5/5 claim
  and made the exact policy test fail before the restored policy passed 4/4.

- **[#87]** Returning onboarding now persists the selected adapter and config
  on the existing lead instead of leaving the saved agent on Claude while the
  UI displays Codex. Changing adapters clears a stale model; reselecting the
  same adapter preserves an intentional model override plus hidden
  ACP/profile/arguments/workspace/runtime/timeout policy. Only onboarding-owned
  fields are overlaid on a same-adapter resume; an adapter change still drops
  stale adapter-specific state. The Review step reads the saved agent, compares
  the server-normalized saved configuration, displays its persisted
  adapter/model, and blocks **Get started** on a pending, failed, mismatched, or
  reload-without-exact-expectation readback. Returning agents test the effective
  merged command/cwd/env configuration before PATCH, so a failing preserved
  configuration cannot advance. The final set passed 21/21 plus UI typecheck.
  Deliberate launch-gate, destructive-replace, and draft-instead-of-effective-
  config regressions failed for their exact reasons before byte restoration.
  Independent static review is GO with no P0/P1; opaque server-owned config
  revisions/CAS and controller extraction remain tracked in #105 and #107.

- Narrow-viewport follow-up for #89/#94: members table stacks below `md`
  (the `--gtc-24` 420px floor was the 99px members overflow), dashboard
  charts collapse to one column before `sm`, mobile `<main>` clips
  horizontal overflow, `/onboarding` and two ux-lab routes now have a
  `<main>` landmark, and `prefers-reduced-motion` zeros Tailwind
  `transition-duration`. `/onboarding` remains inside `CloudAccessGate`, so
  the landmark change does not bypass the authenticated access/claim flow.
  Does not close #89 or #94. Does not claim
  Awwwards 8+. Gauntlet 21/21 remains the run 10 receipt only.

- Factory gauntlet run 10 on `:5113` @ `f7a0160fc` is **21/21**. First-pass
  `/ASS/design-guide` rendered 16 capsules, `mainTextLen` 17664, empty
  `consoleErrors`. Receipt:
  `docs/uiux/browser-evidence-2026-08-27/gauntlet-run10-f7a0160fc.json`.
  Tracks #48; does not close #94 or #89.

- Design-guide Issue Output showcase now uses the existing public
  `/paperclip-thinking.svg` instead of a fake `/api/attachments/.../content`
  video. That was the remaining gauntlet Technical quality 404 on
  `/ASS/design-guide`. Run 10 later proved Technical quality 3 on factory
  `:5113`. Tracks #48.

- **[#95]** `db:migrate` now skips DDL that is already true on the live schema
  (existing tables/columns/indexes/constraints, dropped columns, indexes on
  removed columns, SQL-comment prefixes). That repairs a drifted
  `__drizzle_migrations` ledger without wiping embedded-postgres data. Factory
  start still requires a clean checkout after this lands.

- Enrolled the fork in Repo Doctor plan resolution for Projects Ops #117 with
  one `on_demand`, repository-scoped, observe-only genome. Four explicit
  authored-runtime source sets select 3,246 server/CLI, package, UI, and script
  files and exclude the two declared generated files. `node.typecheck` is
  required; `node.lint` and `architecture.boundaries` remain optional, and no
  commit/push gate, exception, analyzer execution, authority, or quality
  decision was added. A deliberately undeclared source-set reference made the
  exact resolver return `invalid`/exit 2 for that reason. Agent Settings
  `c91e70cc` repaired the shared current-report contract, after which the same
  broken input returned `invalid_genome`/exit 2 without exposing private issue
  text. Restoring it made the resolver and shared adapter return
  `resolved`/exit 0. The new genome and ledger entry are declarative governance
  surfaces; no production or test source file changed.

- Separated coordination loading from view projection without changing the
  public response or weakening company isolation (#82). The production facade
  still requires the authorized `companyId`; private loader helpers retain it
  on root, child, participation, lease, intent, instance, and host reads. A new
  pure projector receives a fixed observation time, which makes status,
  heartbeat, placement, lease, participant, and control mapping deterministic
  to test before #53 adds truthful v2 semantics. Root reassignment after scope
  authorization now has an explicit fail-closed regression. Caller-shaped
  negative proof, 42/42 focused tests, server typecheck, the real pre-push
  workspace typecheck, and independent static review passed. Review hardening
  also proves newest-heartbeat selection is independent of participation row
  order. This slice does not adopt `task-coordination.v2` or change current
  evidence claims.

- Scoped coordination-detail reads to the authenticated root company (#52).
  The route now rejects anonymous callers before the root-scope lookup and
  returns the same not-found response for missing and foreign-company roots.
  The detailed service requires the authorized company identifier and retains
  that predicate across child issues, participations, leases, control intents,
  agent instances, and hosts. Focused route and embedded-PostgreSQL isolation
  fixtures cover anonymous, foreign-board, foreign-agent, inconsistent-row,
  and real HTTP-to-database boundary cases. Caller-shaped negative proof and
  restored validation passed, including 10/10 focused tests and server typecheck.

- Prevented the local ACP process-session proxy from forwarding late stdin
  events after a remote terminal frame has already ended its socket (#59).
  The exact PR #66 hosted shard exposed the race as
  `ERR_STREAM_WRITE_AFTER_END`; the proxy now ignores writes once it is
  exiting, destroyed, or writable-ended. The owning streamed-order test now
  holds stdin open through terminal output and proves a late EOF exits cleanly;
  buffered data is also drained before a runner rejection without accepting a
  buffered terminal frame as proof, and the terminal error uses a flush-safe
  socket close so backpressure cannot discard queued data. Remote termination
  probes use bounded deadline-clamped backoff, and proven wrappers receive a
  separate bounded cleanup window. The same real hook
  also exposed a cluster of POSIX-only `0600`/`0700` assertions, a bare `sh`
  fixture, and literal `/` temp-path prefixes in the Codex credential tests;
  Windows now retains the functional credential/rotation assertions, POSIX
  continues to verify permission bits, shell-backed fixtures use the reviewed
  Git-for-Windows resolver, and temp paths use native joins (#22). The next
  hosted shard exposed a stale OpenCode missing-command assertion; it now checks
  the earlier, attributable PATH-resolution error introduced by this branch.
  The final exact-head review also hardened the late-EOF test helper so a
  missing output marker closes stdin, reaps its child, and consumes the pending
  exit result before returning the timeout. The fixture launches its idle child
  through `process.execPath -e` so the same custody proof is executable on both
  Windows and POSIX hosts.

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

- Normalized drive-letter paths before embedding them in Git workspace and
  sandbox asset-provision shell commands, exposed the canonical provision-path
  quoting helpers for adapter extensions, and isolated Git workspace fixtures
  from host-global Git configuration (#63, #70).

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
