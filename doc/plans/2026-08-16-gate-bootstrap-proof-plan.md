# Gate/bootstrap repair proof plan (2026-08-16)

## Scope and current state

This change prepares the repairs tracked by #67, #68, #73, #76, and #77:

- make the adapter/runtime no-`git push` scanner fail closed for missing or
  empty required roots, links/junctions, unreadable trees, tracked generated/cache
  directories, unsupported entries, encodings, and undeclared file types while
  explicitly excluding only Git-proven untracked package/build output;
- use language-aware command lexing for JS/TS, shell, PowerShell, Python, and
  configuration sources, including continuations and array invocations;
- invoke the scanner and workflow-trigger policy from both platform pre-push
  callers;
- replace the uncapped import-graph test invocation with exact changed/sibling
  tests routed to `node:test`, Vitest, or hosted PR CI;
- bind Git's four-field pre-push update stream to one pristine checked-out HEAD,
  the configured push URL, and the destination's authoritative advertised dev;
- keep pre-push evidence under Git-private storage so the gate does not dirty
  the worktree it validates;
- run PR CI for pull requests into `master` and `dev`, with no `push` event; and
- scan only the exact pull-request commit range with the pinned Gitleaks binary.

Focused broken/restored receipts and three independent final reviews are
complete on the exact repaired implementation manifest.
Post-merge-base validation is complete. PR #78 ran its full hosted matrix green
on `5cf55ae1`; CodeRabbit then raised 11 actionable findings on that exact head.
The valid findings are repaired and locally proved; repaired-head hosted CI and
CodeRabbit readback remain pending.
The final repaired local bundle passed 113/113 focused tests on 2026-08-17;
the earlier caller-exact broken/restored receipts remain unchanged.
The durable receipt is
`C:/Dev/paperclip-gate-repair-logs/coderabbit-round1-final-20260817T000325/final-repaired-snapshot-receipt.json`;
its 21-file implementation manifest is bound by SHA-256
`877ea6967bc6920f4f0158a8ab0b2ade411bf45d469e655b2a759668670e1c92`.

## Maintainability receipt

Physical line counts are used below so comments and guard explanations remain
visible. `new` means the file is introduced by this repair.

| File | Before | After | Decision |
| --- | ---: | ---: | --- |
| `scripts/check-no-git-push.mjs` | 321 | 499 | Filesystem/tracked-tree integrity orchestrator stays below the production target; lexical and manifest helpers are extracted. |
| `scripts/check-no-git-push-source.mjs` | new | 420 | Language-aware command lexer/detector with grammar-aware PowerShell here-string, shell heredoc, and shell arithmetic states; all heredoc-associated lines remain scan-visible and ambiguous data-language markers are disabled. |
| `scripts/git-push-scan-integrity.mjs` | new | 117 | Tracked-manifest normalization, bounded Git enumeration, scoped/repository-wide hidden-index rejection, and missing-path reconciliation. |
| `scripts/git-push-scan-integrity.test.mjs` | new | 107 | Enumeration bounds/failures, scoped/repository-wide index-state, case-semantics, and missing-manifest fixtures under the selector-required sibling name. |
| `scripts/check-no-git-push-source.test.mjs` | new | 327 | Adversarial language/command/marker fixtures, including executable multiline data, column-zero here-string closure, scan-visible quoted/unquoted and continued LF/CRLF heredoc bodies and terminators, modern, legacy, and indexed-array arithmetic shifts, nested command substitutions, quote removal, and batch continuations. |
| `scripts/check-no-git-push.test.mjs` | 416 | 700 | Filesystem and tracked-manifest integration matrix; helper-level assertions moved to their selector-required sibling suite. |
| `scripts/pre-push-check.ps1` | 248 | 218 | Thin Git-private logging/orchestration caller with streaming output and temporary-update cleanup. |
| `scripts/pre-push-check.sh` | 145 | 156 | POSIX mirror with isolated-log override and exact temporary update/step cleanup. |
| `scripts/run-vitest-stable.mjs` | 695 | 748 | Existing runner plus exact-file mode; reviewed exception required. |
| `scripts/__tests__/run-vitest-stable-shard.test.mjs` | 180 | 194 | Exact/related shard incompatibility and stable-runner partition proofs. |
| `scripts/run-vitest-direct.mjs` | new | 52 | Shell-free canonical Vitest launcher with manifest-bin containment validation. |
| `scripts/run-vitest-direct.test.mjs` | new | 48 | Manifest-bin, containment, and hostile-literal-argv fixtures. |
| `scripts/verify-gitleaks.mjs` | 88 | 106 | Strict full-object-id range mode. |
| `scripts/verify-gitleaks.test.mjs` | 80 | 107 | Exact-argument and symbolic-range regression coverage. |
| `scripts/check-pr-workflow-trigger.mjs` | new | 367 | Strict trigger/job/dependency/runner/execution-context/active-command policy checker split into cohesive validators. |
| `scripts/check-pr-workflow-trigger.test.mjs` | new | 332 | Missing-branch, YAML-key, duplicate-job-key, dependency, opener, execution-context, runner, custom-shell, and masked-command bypass fixtures. |
| `scripts/is-main-module.mjs` | new | 24 | Realpath-aware fail-closed ESM entry helper. |
| `scripts/is-main-module.test.mjs` | new | 36 | Alias, invalid-path, and falsy-entry fixtures. |
| `scripts/pre-push-test-selection.mjs` | new | 352 | Canonical selector with pushed-HEAD membership, exhaustive path ownership, and deletion routing. |
| `scripts/pre-push-test-selection.test.mjs` | new | 265 | Runner, pushed-HEAD tracking, runtime-asset ownership, deletion, and path-integrity fixtures. |
| `scripts/run-pre-push-tests.mjs` | new | 439 | Bounded Git-protocol/HEAD/remote planner and runner dispatcher with repository-wide normal-index binding; Git's literal `HEAD` local-ref form is accepted only with the same object binding. |
| `scripts/run-pre-push-tests.test.mjs` | new | 428 | Protocol, real rename, literal-HEAD compatibility, authority, timeout/buffer, cleanliness, hidden-index, and exit fixtures. |
| `scripts/pre-push-callers.test.mjs` | new | 221 | Static wiring plus portable real-caller exit, argument, log-isolation, and cleanup fixtures. |
| `scripts/scan-pre-push-secrets.mjs` | new | 133 | Exact outgoing-range orchestrator reusing canonical remote validation. |
| `scripts/scan-pre-push-secrets.test.mjs` | new | 130 | Remote type/authority, deletion, and child-exit fixtures. |

Largest-function and complexity proxy review:

- `runCheck` in `check-no-git-push.mjs` is about 157 physical lines and
  `collectScannableFiles` is about 107. Both cross the 80-line independent-review
  threshold. They keep one fail-closed state machine each: orchestration/reporting
  and one iterative directory walk. Command lexing is now extracted; nesting is
  at most four levels and there is no recursive walk.
- `lexSource` in the extracted detector is 157 physical lines. It crosses the
  80-line independent-review band because it owns one cohesive, non-recursive
  lexical state machine; here-string/heredoc header parsing and batch comments
  are extracted, and nesting remains at most four levels. Quotes, expansions,
  escapes, and legacy arithmetic deliberately make the remaining source
  scan-visible because fully duplicating shell grammar would be less reliable
  than a bounded false positive. Every heredoc body and exact delimiter line
  remains scan-visible, even when its delimiter is quoted, so a false heredoc
  classification cannot hide a later command. `readShellHereDocWord` is 53
  physical lines: it exceeds the
  50-line target but remains below
  the 80-line review threshold, and splitting its quote/removal state would
  increase drift. Independent security review is required and recorded before merge.
- `selectPrePushTests` is 85 physical lines, crossing the 80-line independent-
  review band after pushed-HEAD validation was made unconditional. It remains
  one cohesive selection/result contract; discovery and path validation are
  extracted, nesting is at most four levels, and splitting the shared coverage
  sets from result construction would increase state drift. The exception was
  independently reviewed on the repaired snapshot.
- `resolveOutgoingChangedFiles` is about 60 physical lines, above the 50-line
  target but below the independent-review threshold; existing/new-branch range
  resolution stays together so both paths share remote validation and rename
  handling. Other planner functions remain at or below 50 physical lines. The
  CLI tail is linear and has no nested process graph.
- no complexity analyzer has been run in this resource-constrained edit phase;
  the preceding function length and nesting review is the explicit proxy.

The 748-line `run-vitest-stable.mjs` exception is deliberate but must be
independently reviewed before merge. Its existing roughly 179-line
`parseCliOptions` state machine keeps mutually exclusive modes and their shared
defaults together; splitting option state would increase drift. Exact-file
parsing reuses the established isolated Vitest process contract, while process
launch was extracted into the 52-line shell-free `run-vitest-direct.mjs`.
Duplicating isolation in a second runner would increase drift and rollback risk.
The scanner filesystem test is
700 lines after lexer and manifest-helper fixtures moved to their 327- and
107-line owning suites; all remain at or below the test-file target and none
needs an oversized-test exception.

PowerShell review: all changed lines in `scripts/pre-push-check.ps1` are at most
120 characters. PSScriptAnalyzer 1.24.0 ran with default rules plus enabled
`PSAvoidLongLines` at 120 characters: 0 errors and the same 2 existing
`PSAvoidUsingWriteHost` warnings as the baseline. Existing long lines in
`scripts/pre-commit-check.ps1` were not introduced or expanded by this repair.

## Required negative proofs

Every proof asserts the break was applied, captures the failing exit and
specific reason, restores the fixture, and captures the pass. The 2026-08-16
focused receipts and exact outcomes are recorded in `.gate-evidence.json`;
hosted exact-head proof remains a separate post-push requirement.

| Gate | Broken input and required failure | Restored proof |
| --- | --- | --- |
| no-`git push` scanner | Remove/empty a required root; inject Git/stat/realpath/read/list failures, root/nested/ancestor/generated-name links, tracked generated directories, a tracked path with skip-worktree/assume-unchanged state, unsupported entries/types/encoding, and YAML/Python/PowerShell/batch marker spoofs; seed indented fake PowerShell closers, fragmented ordinary/ANSI-quoted and line-continued shell-heredoc delimiters, modern, legacy, and indexed-array arithmetic left shifts, a falsely recognized delimiter that exactly equals a later push command, nested command substitutions with misleading comment/quote parentheses, executable multiline substitutions, cross-language commands, quoted subcommands, send-pack, and line-leading-division bypass forms. Integrity cases exit 2 with path/reason; commands exit 1 with file/line. | All roots and tracked paths are restored and observed with normal index state, untracked generated output is excluded only after case-correct tracked-tree proof, only grammar-valid column-zero here-string closers and exact heredoc terminators change multiline state, every heredoc body and terminator line remains scan-visible regardless of delimiter quoting, shell arithmetic never enters a hiding state, ambiguous quotes/expansions/escapes remain conservative, and exit 0 carries non-zero coverage. |
| exact selector | Delete a changed test/source, omit the pushed-HEAD tracked set, use an untracked sibling, add uncovered production, pass an escaping/whitespace/symlink path, and change root/runtime non-JS files. | Exact surviving Node/Vitest siblings are loaded from the pushed/current HEAD tree, tracked, and assigned once; deletions that cannot execute locally and every remaining non-doc path are declared hosted CI. |
| Git update planner | Empty/malformed/deletion protocol, dirty/staged/untracked worktree, repository-wide skip-worktree/assume-unchanged state, non-HEAD and multi-ref updates, non-string/mismatched remote identity, malformed remote-dev advertisement, injected timeout/ENOBUFS, and child exit 19. A real Git rename must expose both old and new paths. The first real `HEAD:topic` push also proved that rejecting Git's literal `HEAD` local-ref is a false lockout. | One pristine HEAD with a normal index uses the configured destination's advertised dev; both `refs/heads/...` and literal `HEAD` local-ref forms remain bound to the same checked-out object, Git children carry timeout/buffer bounds, renames select both sides, and restored child exit 0 passes. |
| platform callers and Husky | Fake scanner exit 17, secret exit 23, and planner exit 19 through both real callers; omit the remote location; verify logs resolve under Git-private storage and no update/step artifact survives failure. | Fake children exit 0, both remote arguments reach both planners, the consolidated log remains, temporary artifacts are absent, and restored dispatch passes. |
| PR workflow policy | Remove `dev`; add plain, quoted, escaped, duplicate, or whitespace-padded event keys; duplicate a required-job key; alter the policy dependency; inject top/job/step env/defaults, containers/services, self-hosted runners, working directories, comments, conditions, or masks while retaining the exact command text. | Real workflow has one plain pull-request event for master/dev, no push event, unique ubuntu-latest required-job keys, policy depending exactly on secret-scan, one unmasked exact secret range, and active unmasked gate regressions. |
| exact Gitleaks range | Supply a symbolic range or mismatched destination; validation exits before Gitleaks. | Full authoritative base/head IDs are forwarded as one exact `--log-opts` argument. |
| shell-free Vitest launch | Pass a filename containing cmd metacharacters and invalid/missing/escaping package-manifest `bin` values; capture the spawned command/argv. | The installed in-package Vitest entry resolves and the filename remains one literal argument to `process.execPath`, with `shell:false` and no side effect. |
| stable exact Vitest mode | Combine `--files` or `--related` with shard-count alone. | The caller rejects the incompatible value; valid exact/related and duration-balanced shard plans remain deterministic. |

Focused commands are recorded in `.gate-evidence.json`. Do not substitute a
broad test sweep for these failure-reason assertions.

## Hosted bootstrap and rollback

After focused local proofs and independent maintainability review:

1. commit and push the atomic bootstrap branch;
2. read back the PR head and review state;
3. merge the bootstrap only after its available local/third-party evidence is
   green;
4. refresh a dependent PR into `dev` and confirm the PR workflow starts, the
   policy tests execute, and no `push:dev` run exists; and
5. record the run URL/outcome in `.gate-evidence.json` and the tracking issues.

Rollback is one atomic revert of the bootstrap commit. The previous pre-push
callers, workflow trigger, selector behavior, and Gitleaks history mode remain
available in Git history; do not partially revert only one caller because that
would recreate a platform bypass.
