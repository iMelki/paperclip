# Day-0 factory branch and worktree consolidation

Status: active; implementation remains on `dev`.

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

## Current live drift

The 2026-08-02 Validator retry `540a4c3f-99e3-4b04-b952-4b8b9314a76a`
failed closed before command execution because the locked envelope did not
include newly dirty candidate paths: `components.json`, the new UI card/tabs
files, and `src/lib/bounded-request-body.ts`. This is evidence drift, not a
reason to widen the envelope in place. The Builder must produce a refreshed
receipt and envelope after the candidate is frozen and reviewed.

The candidate was stable across two 15-second status fingerprints
(`fe5a5e18878795b735c76bb44dfde20e8d892fc316768c784de4cb678153d1f6`), but its
path set now includes unrelated UI additions. Split those paths in a clean PR
or explicitly include them in the reviewed bridge scope before refreshing the
receipt. Never stage the shared dirty root wholesale.

Paperclip's stale local database-backup warning was repaired by a manual backup
at `2026-08-02T10:35:00Z`; health readback now reports
`databaseBackup.status=ok`.

## Upstream risk watch

Before enabling isolated worktrees broadly, recheck current upstream behavior
for dirty/foreign-branch repair, shared-workspace corruption, cleanup data loss,
review self-approval, Windows process-group cleanup, wake coalescing, and plugin
hot-reload event delivery. These are tracked as gates, not silently assumed to
be fixed by an upstream merge.
