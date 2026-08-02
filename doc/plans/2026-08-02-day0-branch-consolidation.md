# Day-0 factory branch and worktree consolidation

Status: active; implementation remains on `dev`; bridge promotion is blocked on
deterministic validation, independent review, release evidence, and the
separate Paperclip history secret-scan gate.

## Rules

- Preserve concurrent dirty worktrees and never reset, stash, or delete them as
  part of factory delivery.
- Builder worktrees are evidence-producing, disposable workspaces. They do not
  push remote branches.
- Only the Integrator/Release Steward uses the primary repository checkout for
  receipt-declared release paths.
- Every consolidation row must identify repository, workspace path, branch,
  issue, base SHA, final SHA, receipt ID, review decision, and remote readback.
- Consolidate a reviewed branch into local `dev` only after the row is complete
  and the working tree is clean for the owned paths.
- Promote the repository's actual promotion branch with a merge commit through
  a reviewed PR. Fast-forward `dev` afterward only when it has not advanced
  independently.

Paperclip uses `master` as its promotion branch. Draft PR
[#26](https://github.com/iMelki/paperclip/pull/26) records `dev` → `master` and
is review-only until every factory gate is green.

## Current inventory (2026-08-02)

| Repository | Active checkout | State | Disposition |
|---|---|---|---|
| agent-settings | `agent/claude/runtime-tmp-cleanup-2026-07-29` | dirty, concurrent cleanup work | Preserve; owner must finish or park it before any dev consolidation |
| agent-settings | linked worktrees for #488, #499, browser bootstrap, revenue import | some locked/active | Do not remove; reconcile each branch to issue and remote SHA first |
| paperclip | `dev` at `c5a4ba433` | clean source checkout | Controlled Integrator/release checkout |
| mission-control-kanban | `dev` at `820a9058` | dirty bridge candidate | Preserve candidate; Paperclip must produce release evidence before commit |

Additional inventory: Agent Settings has a dirty cleanup root and locked or
active linked worktrees for #488, #499, and browser bootstrap. Projects Ops has
dirty report output and a separate dirty Asimtop worktree. MCK has an existing
clean security PR (#42) that is unrelated to the dirty bridge candidate.
Paperclip, Agent Settings, MCK, and Projects Ops do not currently have GitHub
branch protection, so the documented PR and human-review gates are operational
controls, not server-enforced defaults.

## Gates

1. Start and health-check Windows Paperclip and MCK.
2. Obtain fresh Validator evidence with `createdByRunId` equal to the run and a
   locked evidence document.
3. Obtain an independent Reviewer acceptance.
4. Release exact receipt-declared MCK paths from the Integrator workspace,
   attest `origin=iMelki/*`, branch `dev`, and read back the pushed SHA.
5. Install and health-ping the bridge, then dispatch MCK #46.
6. Reconcile all remaining worktrees with an additive manifest; park or merge
   only with explicit ownership and clean-path proof.
7. Prepare repository-specific `dev` to `main` PRs; merge only the explicitly
   authorized promotion after review and natural-run evidence.

## Safe consolidation sequence

1. Freeze each dirty or locked worktree. Capture status, HEAD, binary diff,
   untracked-file manifest, and lock metadata.
2. Map every path to an owner, issue, or PR. Classify generated logs as retain
   or ignore. Do not bulk-clean them.
3. For uncommitted work, create a clean copy from current `origin/dev`, apply
   only a hash-verified patch, run focused and full checks, commit with issue
   trailers, push, and open a PR into `dev`.
4. Read back the PR body, checks, review, and merge SHA before merging.
5. Only after clean-state and owner confirmation, unlock or remove a linked
   worktree with Git's worktree commands. Never remove a dirty tree by force.
6. Delete a remote branch only after its PR is merged and the merge SHA is
   read back.
7. After `dev` settles, refresh the promotion PR (`master` for Paperclip,
   `main` elsewhere), require checks and human review, merge with a commit,
   and fast-forward `dev` only when it has not advanced independently.

## Current live drift

The 2026-08-02 Validator retry `540a4c3f-99e3-4b04-b952-4b8b9314a76a`
failed closed before command execution because the wake contract named
envelope revision 7 and manifest `sha256:02ccb055...`, while the authoritative
locked envelope is revision 8 with manifest
`sha256:375d980e84d324d9efab58f44e0ac3f7f9bcb6828c7cf078b2ab6c2a0470bad7`.
The subsequent Builder retry `e297d7bb-3046-4bc3-8ad1-4579d73618ef` proved the
same contract drift and recorded `needs_human` without changing candidate
bytes. This is evidence drift, not a reason to widen the envelope in place.
The board must renew ASS-19 against revision 8, or restore the older manifest,
before another Builder wake.

The candidate was stable across two 15-second status fingerprints
(`fe5a5e18878795b735c76bb44dfde20e8d892fc316768c784de4cb678153d1f6`), but the
worktree now reports 68 paths after excluding `.local-logs/**` and `.tmp/**`.
The locked receipt intentionally covers 59 paths and preserves the bounded
request-body helper plus generated/runtime debris out of scope. The additional
`components.json`, UI primitives, `src/lib/utils.ts`, `MissionQueue`,
`Panel`, and `WorkspaceSectionTabs` paths must therefore be owner-mapped and
split into a clean PR or explicitly included in a newly reviewed bridge scope.
Never stage the shared dirty root wholesale.

Paperclip child issue ASS-23, **Reconcile MCK paths outside the locked bridge
envelope**, now owns that path map. Its body was read back after repair with
newline-preserved evidence, and it explicitly forbids wholesale staging,
reset, stash, worktree removal, release, or promotion. ASS-19 may be renewed
only after ASS-23 produces the owner/path manifest or a reviewed scope change.
The locked `path-owner-manifest` document on ASS-23 records all nine extra
paths with content hashes: eight UI/dependency paths map to MCK #48 and the
unused bounded request-body helper maps to MCK #75 for separate security
review. The document was locked by `local-board` at
`2026-08-02T10:59:33.69Z`.

Paperclip's stale local database-backup warning was repaired by a manual backup
at `2026-08-02T10:35:00Z`; health readback now reports
`databaseBackup.status=ok`.

Builder run `e297d7bb-3046-4bc3-8ad1-4579d73618ef` finished `succeeded` at
`2026-08-02T10:49:59.248Z`, but its deliberate disposition is
`needs_human`: live manifest SHA differed from the stale wake contract and no
receipt/envelope refresh was attempted. Paperclip's liveness recovery issue
ASS-22 was created because ASS-19 had no explicit next action; resolve that
escalation only after the board renews the contract and names the next bounded
Builder or Validator action. Issue #24 remains the runtime observability note
for the transient ACP-handshake/no-PID behavior; do not treat the completed
run as validation, review, release, or bridge completion.

## Upstream risk watch

Before enabling isolated worktrees broadly, recheck current upstream behavior
for dirty/foreign-branch repair, shared-workspace corruption, cleanup data loss,
review self-approval, Windows process-group cleanup, wake coalescing, and plugin
hot-reload event delivery. These are tracked as gates, not silently assumed to
be fixed by an upstream merge.

## Latest Builder disposition (2026-08-02)

Builder run `d07e5b06-3bf5-458d-9e8b-fa9db5acc8d3` finished `succeeded` at
`2026-08-02T11:15:49.167Z`, but its declared outcome is `needs_human` rather
than completion. The run verified the revision-8 envelope, manifest
`sha256:375d980e84d324d9efab58f44e0ac3f7f9bcb6828c7cf078b2ab6c2a0470bad7`,
base/HEAD/origin-dev `820a90582af8a86a62050727beeab7efe7cb4598`, the exact
59-path candidate, and stable snapshot
`sha256:b90e681ad7a9fea57e9dd5617cd197e24912943e6d80de61e84adc9fa6a6e7dd`.
All nine ASS-23 owner-mapped paths remained unchanged. No candidate file,
index, commit, push, release, callback, or Validator command was performed.

The run's receipt preparation failed twice before any Paperclip PUT:

1. PowerShell parser error (`Missing expression after ','`) while building the
   owner-mapped array.
2. Tool JavaScript parser error (`Invalid or unexpected token`) while preparing
   the repaired payload.

The run correctly stopped at the two-attempt repair ceiling and recorded the
evidence in Paperclip comment
`2fe9b39c-279c-472f-85a1-34135e425622`. Readback confirms that
`builder-run-receipt-5` does not exist. The local board then applied the valid
blocked disposition with `unblockDescriptor.owner=board`; adding that comment
also woke a fresh run automatically, so exact run
`2a240462-05bc-41d9-8525-0a44a9063818` was cancelled and read back as
`status=cancelled`, `errorCode=cancelled`. ASS-19 is now `blocked` with no
active run. This is a control-plane wake side effect to account for in future
operator comments: status-only PATCHes must be used when a wake is not wanted.
The incident is tracked in Paperclip [#25](https://github.com/iMelki/paperclip/issues/25)
comment `5157477304` as a recovery-loop/wake-policy defect.

The board created and locked `builder-run-receipt-5` from the recorded evidence;
its Markdown fence was then corrected in locked `builder-run-receipt-5-corrected`.
ASS-23's owner map exposed a contract mismatch in the original revision-8
envelope: the live validator sees nine owner-mapped paths, but only the bounded
request-body helper was declared preserved. The board therefore unlocked and
revised the canonical envelope to revision 9, locked at
`2026-08-02T11:26:32.484Z`, with 12 preserved path patterns and unchanged 59-path
Builder scope. The revision-9 receipt is locked as `builder-run-receipt-6` with
raw body hash `sha256:49e79132508ef30a1b629ffef4660e3fed86084b57f8f4e700e78a09096ca187`
and canonical JSON hash
`sha256:fc39298a09985739e4594378b11ddb6d61abbc698cc32281962c45b93f75cb2a`.

The first revision-9 Validator run `0044b707-e3ea-4ec0-a16b-e22c30a8f03b`
passed four exact commands, then failed only
`paperclip-host-migration-policy`: the bridge package pins host commit
`c5a4ba433...` while the owned Paperclip `dev` checkout is
`8221d2c03...`. No mutation occurred. Paperclip recovery then emitted repeated
exit-2 continuations for the same failure fingerprint, so the Validator agent
was paused and ASS-11 blocked. Child ASS-25 now owns a narrow Builder repair of
the host compatibility sentinel; it must not touch MCK #48's UI/dependency paths
or release/push. Do not start another Validator run until ASS-25's receipt and
focused host-migration test pass are read back.

## Isolated bridge PR consolidation (2026-08-02)

The board fallback was completed in a separate clean clone rather than
staging the active dirty MCK checkout. The exact receipt-declared 59-path
snapshot is pushed as MCK PR
[#119](https://github.com/iMelki/mission-control-kanban/pull/119), branch
`factory/bridge-consolidation-20260802`, commit
`a05ca7c22fd18fbad8983e6b5f4a999703f4ba43`, targeting `dev`. The root
`package-lock.json` and the nine ASS-23 owner-mapped MCK #48/#75 paths were
excluded; the active MCK index remains untouched.

The first clean-clone install exposed two reproducibility defects and both were
repaired without widening the delivery:

1. The copy initially omitted the modified root lockfile, which made `npm ci`
   correctly fail. The bridge PR scope was then separated from the MCK #48
   dependency batch: root `package.json` retains only bridge test scripts and
   the base root lockfile is restored.
2. `npm ci --ignore-scripts` omitted the native `better-sqlite3` binding and
   nested bridge dependencies. The final evidence installs both root and
   bridge lockfiles and explicitly rebuilds `better-sqlite3` before tests.

Final clean-clone evidence is recorded in the locked Paperclip document
`ASS-25/board-fallback-pr-receipt` (revision 1,
`973a9c1e-c5c8-4217-9a26-8feb48fdd6b4`): bridge typecheck and 36 tests, 17
factory webhook tests, host provenance (five migrations/59 statements), five
Docker-backed PostgreSQL migration scenarios with cleanup verification, root
typecheck/full tests/lint/production build, and staged Gitleaks protection all
pass. The two deterministic SDK-provenance scanner findings use exact inline
`gitleaks:allow` annotations, matching the existing Paperclip fixture policy;
no blanket ignore or scanner bypass was added.

ASS-25 remains `blocked`/`needs_review` and ASS-11 remains paused. No direct
MCK `dev` commit, release, callback, or merge was performed. The next control
plane gate is GitHub CI plus independent review of PR #119; only after a green
merge into MCK `dev` may ASS-11 run once against clean `dev`.

## Promotion PR secret-scan gate (2026-08-02)

Paperclip PR [#26](https://github.com/iMelki/paperclip/pull/26) remains draft
and review-only. Required run
[`30744851893`](https://github.com/iMelki/paperclip/actions/runs/30744851893)
failed `secret-scan` while scanning complete history with pinned Gitleaks 8.30.1.
The findings are pre-existing token-shaped synthetic values in historical test
fixtures (for example `remote-mcp-headers.test.ts`, `TokensPanel.test.tsx`, and
Google Sheets MCP test files); `verify` and `e2e` were skipped downstream and
are not independent failures. Issue
[#13](https://github.com/iMelki/paperclip/issues/13) now contains the exact
read-back evidence and classification plan. No blanket allowlist, scanner
bypass, history rewrite, or branch merge is allowed until each finding is
classified, inert fixtures are made unmistakably inert where practical, the
current and complete-history scans pass (or alerts are explicitly resolved),
and PR checks rerun green.
