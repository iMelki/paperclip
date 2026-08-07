# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

- Added fail-closed dev-runner generation custody for #20/#28. Each launch now
  acquires an exclusive, append-only claim journal, fsyncs an immutable claim
  header before spawn, appends and fsyncs the accepted child identity, and
  retains that evidence until an exact, generation-matched registry publication
  is read back. Raw registry writes and removals acquire the same claim namespace
  through a distinct mutation guard, so a legacy/control CLI cannot cross a
  generation launch. Claim and guard release are stateful and retryable across a
  post-rename interruption; a rejected premature asynchronous release can be
  retried after correct publication. Same-inode/content checks, canonical case
  fencing for temporary names, pre/post-link hashes, file and supported POSIX
  parent-directory fsyncs, and explicit Windows durability boundaries preserve
  evidence rather than inferring success. Focused Windows coverage passes 45
  tests with five POSIX-only skips, Ubuntu-24.04/WSL passes the 37 core lifecycle
  and registry cases, and server TypeScript is clean. A targeted workspace
  rollback test reached the retained-claim assertions but its final test cleanup
  correctly refused an `untrusted_identity`; the two exact temporary evidence
  roots remain preserved under #20, and this is not a complete-suite receipt.
- Hardened runtime-service lifecycle evidence for #20. Natural wrapper exit no
  longer implies that its descendants stopped: in-memory services retain a
  failed/unhealthy record while a POSIX process group or stable Windows
  lineage survives, startup reconciliation includes failed services, and
  migration `0198` persists process-group identity before readiness.
  Persisted process ids, process-group numbers, and restart-adopted registry
  rows remain observability evidence only and cannot authorize a signal until
  an OS-stable process birth identity is persisted and verified. Numeric id
  reuse therefore fails closed. Cross-platform crash/restart orphan, clean
  natural-exit, adapter-managed stop, and stale Windows PID regressions cover
  the boundary. Heartbeat cancellation, shutdown, orphan recovery, and
  source-resolved recovery now apply the same rule: a live PID or process
  group reconstructed only from persisted state is retained for human review
  and never signalled without a live child handle. Missing PID/process-group
  metadata for a tracked local adapter is also missing custody evidence, not a
  clean stop. Hot-restart, orphan-reaper, graceful-shutdown, cancel, pause, and
  source-resolved recovery paths retain the run, issue, environment, and
  runtime evidence instead of terminalizing or starting overlapping work.
  The dev runner inspects retained registry evidence before and after adoption
  and refuses a replacement when prior tree absence is unproved. `dev:stop` and
  `scripts/kill-workspaces.sh` exit nonzero and retain registry evidence for
  live or unproven persisted-only records. Follow-up Windows hardening keeps an
  unprobeable persisted process tree—including the production shape with a
  dead wrapper PID and null process-group id—in needs-human state. Windows CIM
  lineage snapshots are advisory because an unobserved intermediate can create
  a surviving grandchild between samples; absent a launch-time Job Object or
  equivalent kernel receipt, even successful `taskkill /T` plus root exit never
  becomes confirmed tree-stop proof. Focused
  tests cover standalone stop, heartbeat/recovery, hot restart, and descendant
  survival. POSIX liveness probes now treat only `ESRCH` as proven absence;
  `EPERM` and unknown errors remain live-or-unproven. Process group `1` can no
  longer become the `kill(-1, signal)` broadcast target, probe identifiers are
  bounded to Node's positive int32 range, unresolved own-group identity fails
  closed, and a selected process-group signal can never downgrade to PID-only
  termination. Focused Windows and Ubuntu/WSL regressions cover probe, TERM,
  forced-kill, and no-fallback behavior. The fresh complete-suite process
  receipt remains the #20 gate.
- Tightened #22 command-managed upload confinement by rejecting raw `..`
  components before normalization. The current cwd check remains lexical and
  does not yet prove post-resolution POSIX symlink or Windows link/junction
  containment; realpath-aware confinement remains open. On
  Windows, repo-managed `bash`/`sh` provision commands now invoke the same
  resolved Git shell that owns the outer command instead of accidentally
  resolving the nested interpreter to WSL; absolute script paths remain
  shell-native across drive letters and spaces. The Windows hook no longer
  rewrites the global PATH to prefer System32: host tar creation resolves
  System32 `tar.exe` narrowly, while all five server fake-sandbox helpers use
  the canonical Git POSIX-shell resolver. Hostile System32-first focused tests
  pass 61/61 server cases and 35/36 adapter cases with one prerequisite skip.
  Valid UNC paths now convert to double-slash shell paths while malformed and
  device-namespace forms fail closed; command-managed regressions cover spaces,
  apostrophes, confinement, and prefix escapes.
- Expanded #28 observer redaction across mutation paths, participant freeform
  fields, PR/check/receipt evidence, retry state, drift details, and exact
  placement/Git working-state evidence while preserving exact evidence only for
  an authorized task team. Startup runtime
  reconciliation now logs adopted, stopped, and needs-human counts explicitly.
- Preserved the failed normal-hook evidence for the coordination slice. The
  40m31s run passed server 3,361/7 skipped, UI 3,131, root 254, shared 380,
  skills 21, token checks, and staged Gitleaks, but failed one plugin typecheck
  and four DB tests. Its process receipt added nine Postgres candidates and no
  listeners, while the wrapper itself contaminated the before count. No commit
  was created and no hook bypass was used; #20, #22, #28, #29, and #31 remain
  open until repaired evidence is committed and read back.
- Repaired the blockers exposed by that hook without bypassing it. The
  workspace-diff plugin no longer passes obsolete editor props, the three
  issue-comment migration cases use the repository's 30-second integration
  ceiling, and database restore can stream canonical `COPY ... FROM stdin`
  sections through the native postgres.js writable API when `psql` is absent.
  The fallback preserves one database session, backpressure, tab/newline data,
  the `\.` terminator boundary, child-before-parent ordering, and fail-closed
  behavior for unsupported dumps. Focused source and built-artifact tests pass;
  the repeated full hook and explicit build remain the release evidence.
- Preserved the second no-bypass hook receipt. It ran for 34m18s and passed
  327 test files, 3,367 tests, all typechecks, token checks, and staged
  Gitleaks. Its only failing suite was the emitted coordination test because
  the server build did not copy the pinned JSON contract into `dist`. The
  receipt added three Postgres candidates and no listeners; none was signalled.
  The server build now copies the contract tree with the existing portable
  filesystem helper. Source tests pass 5/5, emitted coordination tests pass
  4/4, server typecheck passes, and source/built schema hashes match. A fresh
  full hook remains the commit gate.
- Preserved the third no-bypass hook receipt. Server, UI, root, shared, skills,
  database, token, and staged-secret gates passed before the adapter layer
  exposed generated-`dist` test rediscovery, Git-for-Windows shell/path
  selection, process-session cleanup, and environment-boundary defects. The
  source-only adapter matrix now selects one serial worker, prefers native
  Windows `tar`, disables checkout-dependent line-ending conversion for local
  Git fixtures, resolves Windows command shims explicitly, and skips only
  platform or provider prerequisites it can prove are absent.
- Made sandbox process sessions publish queue records atomically by decoding to
  a same-directory temporary file and renaming it into place. Detached launch
  now returns marked launcher and wrapper process identities, checkpoints the
  wrapper PID, consumes `stdinEnd` before exit, drains the child terminal
  receipt, and removes the queue only after both the checkpoint and process
  exit are proven. Failed proof preserves the queue for recovery. Earlier
  failed tests had left 27 synthetic Node wrappers and 27 launchers under 26
  temporary roots; exact-identity reconciliation moved all 26 roots to the
  Windows Recycle Bin and left zero candidates. The stable source-only suite
  passes 322 tests with 25 skips across 20 passing and one skipped file in
  180,071.6 ms, with patch/config bytes unchanged and process-session
  candidates 0→0. The explicit monorepo build also passes in 67,031.5 ms with
  staged bytes unchanged and no new process candidates. A fresh complete hook,
  commit/push/readback, and hosted CI remain the release gates.
- During bounded adapter debugging, a temporary trace captured inherited
  environment variables, including credentials, in tool-visible output and a
  local log. The exact log was moved to the Windows Recycle Bin with the
  canonical safe-removal tool, the instrumentation was removed, and no secret
  values were copied into tracked artifacts. Because tool-visible output
  existed, credentials present in that process environment should be rotated.
  Remote ACPX launches now receive only the explicit adapter and Paperclip
  environment instead of inheriting unrelated host variables.
- Preserved the fourth no-bypass hook receipt. In 2,045,686 ms it passed
  3,363 server tests with seven skips, every non-server gate, token checks, and
  staged Gitleaks; eight fake-sandbox cases failed because the hook-wide
  System32-first PATH selected Windows `find.exe` for POSIX `find` syntax. No
  commit was created. The receipt observed one additional PostgreSQL backend
  candidate and no new listener; it was not signalled. The PATH scope and all
  five fake runners are repaired, the deeper Claude capability case is
  hermetic, and the hostile-PATH focused cohort is green. A fresh normal hook
  remains mandatory.
- Preserved two further no-bypass hook receipts rather than weakening the
  gate. The first reached the adapter layer after every earlier cohort passed
  and exposed GNU tar's drive-letter device parsing; the repair selects the
  Windows tar implementation only for the host archive boundary. The next ran
  for 2,566,059 ms: the general server cohort passed 3,378 tests with nine
  skips across 328 files, then codex-local rediscovered generated tests and
  exposed Windows-only shell, path, signal, POSIX-mode, and timeout assumptions.
  Source-only serial discovery, Git-for-Windows shell resolution, native path
  assertions, platform-independent atomic-failure injection, unique ACP run
  identities, and 30-second subprocess budgets now pass 222 tests with nine
  legitimate platform/prerequisite skips across 23 source files in 117.69s.
  Exact identity-fenced cleanup stopped only the five orphaned embedded-
  PostgreSQL workers created by the failed hook, cleared their eight inherited
  listener rows, recycled only their five proven database roots, and preserved
  the pre-existing port-5432 service. The wrapper's live-PID-only listener
  filter did not observe sockets attributed to dead parent PIDs; #20 retains
  that post-run lineage/journal join as an observability gap.
- Closed the independent-review availability blocker on the #28 company task
  collection. SQL now bounds root expansion before projection, orders by
  `updated_at DESC, id DESC`, defaults to 50 roots, caps direct service callers
  at 100, caps offset at 10,000, and strictly rejects invalid, pathological, or
  repeated HTTP pagination parameters. Each page now loads children,
  participations, leases, intents, active instances, and hosts in one fixed
  batch per table rather than up to seven sequential reads per root. Nested
  collections use sentinel caps and explicit drift; incomplete lease or child-
  work-unit projection withholds every mutation scope because omitted children
  can also omit lease authority. High-fanout fixtures prove the seven-query
  shape and 200 distinct instance memberships without quadratic scans. Focused
  route/service coverage passes 26/26. Offset pagination is deterministic
  per query but not snapshot-stable under concurrent updates; cursor pagination
  remains a later compatibility improvement.
- Replaced the false assumption that Node `0600`/`0700` proves Windows
  credential privacy. Windows now creates each randomized Codex upload and
  same-volume copy-back root atomically through
  `Directory.CreateDirectory(path, DirectorySecurity)`, with a protected,
  inheritable DACL containing only the current user, LocalSystem, and Builtin
  Administrators at the instant the path becomes visible. It fails closed when
  any untrusted SID has parent `DELETE_CHILD`, preventing a parent-authorized
  rename from bypassing the protected child, and revalidates parent/child
  identity after secret population before use. POSIX creates and
  verifies `0700` roots. Copy-back creates the final credential child only below
  that private root and keeps it owner/SYSTEM/admin-only through the identity/
  freshness decision. Only an accepted same-identity, strictly newer credential
  receives the final Codex sandbox-reader ACE, using one complete protected
  `FileSecurity` DACL operation plus identity/exact-DACL readback before atomic
  rename. Cleanup
  retries only the exact child, then requires a nonrecursive empty-directory
  removal and fails loud on residue; staged-home cleanup likewise surfaces both
  the original error and any unproven private residue. Real NTFS tests prove the
  atomic root path, exact trustee sets (including the independently resolved
  optional Codex restricted-token reader), no inherited ACEs, child inheritance,
  long production run-id compatibility, and post-rename policy preservation. A
  spawned restricted-token test preserves bypass-traverse behavior and proves
  the rejected stage unreadable before acceptance and readable only under the
  final policy; the focused credential cohort passes 15 tests with two POSIX
  skips.

- Kept every production remote ACP target hard-disabled under #22. Runner-
  backed sandboxes, runner-less sandboxes, SSH/non-sandbox targets, and custom
  command shapes all fail before workspace materialization, home staging,
  callback publication, provider execution, or local-host ACP fallback. An
  unparseable non-null remote target is treated as remote intent and fails
  closed rather than degrading to a local execution target. An implicit/default
  remote engine remains on the established CLI lane; an
  explicit remote `engine=acp` request fails closed. Only an injected dependency
  in a test process can exercise the inert runner-backed accepted-launch
  controller. Capability flags are insufficient: callback-bridge numeric-PID
  stop is not process-tree custody, and the controller still needs a two-phase
  durable cleanup acknowledgement plus restart reconciliation before any
  production provider may enable this lane. Paperclip remains an observe-only
  coordination and projection foundation; this code does not claim remote
  execution authority.

- Hardened the first task-coordination read foundation for #28: issue detail
  authorization now occurs before loading company-scoped coordination data,
  the response is validated against a pinned Projects Ops contract, unavailable
  Git/process/output/control facts remain explicitly degraded instead of being
  invented, stale participant heartbeats cannot be masked by a newer issue
  edit, collection reads fail closed across company changes, synthetic task
  identity is company-and-issue unique, and GitHub-looking identifiers are
  trusted only for GitHub-origin issues. Exact host/path/process placement is
  returned only to board or an assigned/actively participating agent; other
  in-company agents receive no placement rows. Repository remote URLs are
  sanitized before projection so userinfo, query credentials, and fragments
  cannot enter the coordination DTO.
- Added the #29 credential and idempotency schema foundation. Migration `0197`
  hashes legacy experimental lease tokens before removing their plaintext
  column, enforces unique 64-hex hashes, and adds a company/key-unique 72-hour
  claim ledger whose cached response is documented as non-secret. The write
  API, transaction locking, replay/rejection behavior, cleanup, and safe token
  rotation remain deliberately disabled and tracked.

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
