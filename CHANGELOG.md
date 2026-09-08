# Changelog

- Preserve historical browser proof variants in a verified private archive and dated index without replacing current gauntlet images or receipts.

All notable changes to this repository should be recorded here.

## Unreleased

- **[#114]** Added optional company/system/account-scoped source identities to
  cost events. Identical imports replay without duplicating spend; changed
  payloads return HTTP 409. Company totals and budget pauses are transactional,
  and replay retries failed cancellation. Existing reports without source IDs
  remain append-only. Migration 0214 is prepared; live databases are unchanged.
- **[#115]** Removed synthetic provider/biller budget percentages and inferred
  weekly allowances. Cards show recorded spend with unallocated budgets and
  keep provider-reported quota separate.

- **[#53]** Added and merged (PR #113, `715b453bc`) a fail-closed, additive
  task-coordination v2 route at
  `/api/issues/:rootIssueId/coordination/v2`. It persists a positive root
  coordination generation, vendors and pins the canonical Projects Ops schema
  by SHA-256, keeps company predicates in the loader, limits placements to the
  board or assigned/participating agent, and never claims process/output health
  without independent evidence. Focused v2, route, real HTTP isolation, and DB
  contract tests pass; deliberate audience, evidence-authority, generation,
  and schema-drift breaks fail for the expected reasons with receipts under
  `doc/evidence/coordination-v2/`.

- Addressed PR #108's automated-review findings with caller-shaped negative
  proof: HTTP request logs now omit parsed query/params and query strings,
  attach rejected-request diagnostics only at response time, redact
  board-claim path tokens and URL-bearing headers, omit credential-route
  bodies case-insensitively, and structurally redact ordinary-route bodies.
  Connection-string and credential-code aliases, nonempty plain bindings, and
  camelCase URL/URI fields are covered. The final production-shaped security
  set passes 34/34 after an eight-failure negative control; the independent
  server regression set passes 109/109.

- Kept the same review repair narrow across approval behavior:
  standalone-hire metadata accepts only object records; budget writes are
  tested against the active transaction handle; hire resubmit forwards the
  exact centralized-guard result; and test-only cleanup guarantees PostgreSQL
  trigger/function and second-connection teardown.

- Tightened delivery portability after review. Removed production files keep a
  surviving declared contract test instead of being needlessly deferred to
  hosted CI; the PR #45 census fails early with exact fetch guidance when its
  preservation refs or full history are unavailable and never force-updates
  its protected local WIP branch; SSH fixture admission includes `ps`; all SSH
  destinations terminate option parsing; and direct plus managed runners share
  strict environment-key validation and the reviewed shell quoter. The
  generated Playwright output from focused proof was recycled, not committed.

- **[#47]** Made remote-managed-runtime validation treat `localPath` as a host
  path, accepting POSIX or Windows absolute forms while keeping the remote
  sandbox path POSIX-only. The formerly failing Windows tests and related
  commit hook pass; the real old-head pre-push caller also completed under the
  identity-bound, disk-monitored process owner with zero survivors.

- Hardened deterministic pre-push coverage for production code exercised by
  intentionally higher-level contract suites. Five exact source-to-test
  declarations now reuse the PR #45 generator, HTTP-log redaction, and
  onboarding persistence suites without restoring an unbounded import-graph
  scan. A missing declared test fails closed by exact source and test path; the
  selector proofs pass 19/19, including the new onboarding route helper, and
  the selected contract suites use their exact real runners.

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
  retirement without separate authority. Recovery fetches only the
  remote-tracking ref and creates a missing local preservation branch without
  force; the final owning suite passes 5/5.

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
  Post-review proof also prevents a second private shell quoter and keeps the
  env-lab admission list synchronized with its required `ps` descendant probe.

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
  private-key/secret/token keys, ambiguous bare `token` fields, query objects,
  and sensitive route/path/header values are redacted or omitted through the
  production pino configuration. The final production-shaped negative control
  failed eight exact assertions before restoration; the restored set passed
  34/34, the independent server set passed 109/109, and server typecheck passed
  through the task-owned resource/disk envelope.
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
  Two real Playwright journeys now preserve the submitted adapter/config while
  disabling only automatic wakes, then require Saved configuration to report
  Verified / Claude Code / Adapter default before **Get started** can proceed.
  The shared route helper has its own registered Playwright contract and exact
  deterministic pre-push mapping. The reused Shadcn Badge/StatusGlyph treatment
  passes the repository token gates without arbitrary palette or grid values.

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
- Strengthened the still-unreleased remote callback/process-session custody
  work for #20/#28/#41. Callback launches now use an instance-scoped namespace,
  caller-bound nonce, exact server birth identity, and cooperative cancellation
  tombstone/acknowledgement; the native parent pid and shell `$!` value are
  diagnostic observations only, never shutdown authority. Exact process
  evidence is preserved on mismatch or unavailable proof, and successful stop
  is coalesced and retry-safe. File evidence is atomically visible and flushed;
  POSIX parent-directory fsync is attempted, while Windows parent-directory
  power-loss durability remains an explicit adoption limitation. ACP process-
  session stop rejects when stdin-end or wrapper-exit proof is missing, awaits
  any in-flight event poll, and cannot turn a `released:false` reconciliation
  into exit code 0. A protected Windows Codex-home fixture replaces the unsafe
  `%TEMP%` parent assumption. Every remote callback-backed direct or ACPX
  execution, attended or unattended and over SSH or sandbox transport, is now
  production-disabled before any launch log/event, manifest write, runner call,
  worker/process start, or provider dispatch. Each direct adapter throws the
  stable `PAPERCLIP_CALLBACK_BRIDGE_DISABLED` error. The ACPX entry point
  returns a terminal configuration result with the same error code,
  `phase=preflight`, `retryable=false`, and `needsHuman=true`. Neither path has
  a production override. Any non-null malformed direct or legacy execution
  target also fails closed with the stable, non-retryable
  `PAPERCLIP_EXECUTION_TARGET_INVALID` error instead of falling back to local
  execution.
  Only the exact module-owned capability issued while `NODE_ENV=test` can pass
  the application/high-level adapter seam; booleans, strings, structural clones,
  config, payload, CLI, database, and environment inputs cannot enable it. The
  exported low-level server primitive remains directly reachable for protocol
  research tests, is not a production-safe bypass, and therefore requires a
  static production call-site allowlist proving that the gated high-level seam
  is its only application caller. The gate remains until
  #41 proves a durable pre-dispatch run/adapter/instance manifest, lifecycle
  sink, restart reconciliation, and release/replay fences across all adapters,
  ACPX, and heartbeat. The frozen low-level callback protocol suite passes
  41/41 tests, and the six direct remote-adapter suites pass 67/67 tests with
  SSH/sandbox denial, malformed-input, zero-side-effect, and filesystem-absence
  coverage. The execution-target suite passes 53/53 and the focused heartbeat
  configuration-fence matrix passes 4/4, including a reviewer distinct from
  the source assignee. Full ACPX remains degraded: one run passed 92, failed
  two default-30-second cases, and skipped four; both failed rows then passed
  alone. A fresh run passed 93, failed one different default-30-second case,
  and skipped four; that row also passed alone. A final run passed 88, failed
  six, and skipped four: the first failure retained an accepted session because
  terminal reconciliation was not proven, and five later rows timed out. All
  timeout relaxations trialed for those three observed rows were reverted; an
  earlier separately justified Windows platform budget remains elsewhere in
  the suite. Diagnosis proved that the Windows Git-Bash fixture mixed MSYS
  shell and native Node pid namespaces, so it cannot authoritatively attest
  process-tree custody. The local runner no longer advertises that custody on
  Windows. Thirty real runner-backed lifecycle rows now skip only on Windows
  and remain mandatory on Ubuntu CI; deterministic preflight, parser, gate,
  controller, and local behavior tests continue to run on Windows. The final
  truthful Windows ACPX receipt passed 67 and skipped 34, including four
  pre-existing platform skips. The earlier red receipts are preserved under
  #20/#41. The ACPX test harness now assigns every implicit-cwd execution a
  stable, registered temporary workspace for that test and guards the
  invocation checkout's `.claude/settings.local.json` bytes before and after
  every row. The final focused run left both previously generated checkout-
  local settings files byte- and timestamp-stable; those existing untracked
  files remain preserved for owner classification rather than being deleted or
  staged. This fixture correction does not satisfy the Ubuntu lifecycle,
  restart, residue, or release gates, so the checkpoint remains non-merge-ready
  and non-unattended-ready.
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
  forced-kill, and no-fallback behavior. The fresh isolated workspace-runtime
  suite passes 131 tests, skips 10 intentional platform cases, and fails 0 in
  206.82s. Its bounded post-run ownership scan found zero surviving service
  children or suite-owned test-root survivors. This closes the workspace-runtime
  cohort receipt, not #20: the complete normal hook/global process receipt and a
  per-service single-flight fence for concurrent general stop calls remain open.
  The two company import/export E2E cases now skip explicitly on Windows after
  repeated focused runs proved that their long-lived PowerShell Job custodian
  cannot return a stable terminal receipt on this host; they remain mandatory on
  Ubuntu CI. The fixture also no longer assigns its synthetic Claude agent, so it
  cannot trigger a real provider wake while testing archive portability.
- Made workspace-runtime launch ownership deterministic for #20/#28. The exact
  child and launch claim are registered before the first Windows Job-custody
  await, the blocked child receives its one-shot `go` only after kernel custody
  and accepted-child checkpointing, and the workspace-control transaction
  retains that claim through readiness/registry commit. A custody failure either
  proves the blocked child stopped and releases the claim or retains both
  identities for retry; rollback owns finalization so a late readiness rejection
  cannot double-stop the child or overwrite terminal state. Restart adoption now
  propagates the active launch-claim nonce while refreshing process identity, so
  an unhealthy adopted service is retained as needs-human instead of conflicting
  with its own mutation guard. The foreign-workspace reconciliation fixture now
  expects one needs-human result with the failed/unhealthy row and registry
  retained, never an unauthorized stop.
- Isolated every stable Vitest child under one short run root by setting `TEMP`,
  `TMP`, and `TMPDIR` to the same directory. Supporting fixture repairs supply
  the watchdog adapter type, the exact test-only callback capability for
  Claude/Codex positive remote cases while retaining default-off no-effect
  coverage, and the `editorOptions: undefined` / `edit: false` options required
  by `@pierre/diffs` 1.3.5. Focused validation passes runner 11/11, watchdog
  23/23, server remote fixtures 42/42, and workspace-diff 26/26; server,
  adapter-utils, database, and plugin typechecks are clean.
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
  workspace-diff plugin now passes the `editorOptions` and non-editable `edit`
  values required by the installed `@pierre/diffs` 1.3.5 imperative hook, the three
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
