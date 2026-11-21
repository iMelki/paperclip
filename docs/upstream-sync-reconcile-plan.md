# Upstream sync reconcile plan

Historical investigation: 2026-11-12. Workflow behavior revised: 2026-11-13.

This plan records why Sync from Upstream fails, where the conflicts sit, which fork changes to keep, and the path that puts upstream back into the fork. The trial merge into `master` has 1769 conflicted paths. That is above the 300 path limit, and the conflicts do not resolve mechanically. This document is the reconcile deliverable. No upstream merge branch is opened from this work.

Upstream remote: `https://github.com/paperclipai/paperclip.git`, branch `master`. The revised workflow reads that upstream ref and prepares a verified pointer draft into `dev`. It never calls `repos.mergeUpstream` or updates fork `master` directly.

Tips used for the counts:

| Ref | SHA | When |
| --- | --- | --- |
| `origin/master` | `32c45ecace5e0cbf253eaebe418540c1198416e0` | 2026-11-12 |
| `origin/dev` | `e74b794adfc44f317907dc0ea52714e37cf16773` | 2026-11-12 |
| `upstream/master` | `267983356c6e3c4d5210f106b7b78ec2fa74f1b1` | 2026-11-12 |
| merge-base of master and upstream | `09eceb952af7daa5a23eb5f63d4928c62c67111e` | 2026-05-03 |
| merge-base of dev and upstream | `dbf052577d073bdac511d796e763c0bbd0bd9bab` | 2026-08-28 |

## Recommendation

Use an existing authorized reconcile branch based on `dev`, and review it into `dev`. Promote `dev` to `master` only through the normal promotion. Leave the Aug 9 snapshot commit out of that merge. Keep the fork CI, governance, redaction, and privacy behavior as explicit patches.

The master trial merge is too large to do in this change. A read-only merge of upstream into `dev` is smaller (244 conflicted paths) and is still a source-level reconcile, concentrated in `server/src`, `packages`, and `ui/src`. Treat that as the first staged merge, with human review on database migrations and CI policy.

The revised workflow always prepares a draft pull request into `dev` at the verified upstream tip. It does not attempt a direct update of fork `master`. That draft is a pointer, not a completed merge or acceptance result. Review the staged reconcile branch and preserve fork policy. Leave the pointer draft unmerged.

## Why the sync fails

`.github/workflows/sync-upstream.yml` on fork `master` is dispatch-only. Its only step calls `repos.mergeUpstream` for branch `master`. On HTTP 409 the script logs a warning and calls `core.setFailed`. The job goes red and no pull request is opened.

GitHub recorded 25 runs of this workflow, from 2026-05-04 through 2026-10-19. All 25 failed. Older logs no longer retain step output. The latest retained log is run [39199208839](https://github.com/iMelki/paperclip/actions/runs/39199208839) (schedule, 2026-10-19, head `b791094f6`). That log takes the `err.status === 409` branch and prints "Merge conflict detected. Manual reconciliation required." The commit that made the workflow dispatch-only landed on 2026-10-22, so no later scheduled run exists. The 409 path is unchanged on current `master`.

The histories diverged at `09eceb952` on 2026-05-03 ("Avoid resuming stale remote sessions (Pi adapter)"). Fork `master` then grew 64 commits of its own. Upstream `master` grew 5328 commits that fork `master` does not contain.

One of the 64 commits is the reason a content merge cannot complete. `b2955e099` (2026-08-09, "Review: orphaned test-runtime hardening (7 files, Codex estate) (#50)") changes 3655 files and inserts about 1.43 million lines. Its tree is 361 files away from upstream `19be4cf92` (2026-08-07). The commit message describes a 7-file UI review. The tree is an upstream snapshot from that week, committed onto the May history as one new commit. Git has no shared history for those files, so the later merge reports add/add conflicts for files both sides added, plus content conflicts where both sides kept editing.

After that snapshot, fork `master` changes 47 files. The long conflict list is the snapshot meeting three more months of upstream history, plus those fork patches.

`dev` is a better base. Its merge-base with upstream is `dbf052577` on 2026-08-28. `dev` is 487 commits ahead of upstream and 3781 behind. `dev` is also 2014 commits ahead of `master` and 44 commits behind `master`. The 44 commits are the master-only fork work since the snapshot, including the snapshot commit itself.

## Ahead and behind

| Comparison | Ahead | Behind |
| --- | ---: | ---: |
| `origin/master` vs `upstream/master` | 64 | 5328 |
| `origin/dev` vs `upstream/master` | 487 | 3781 |
| `origin/dev` vs `origin/master` | 2014 | 44 |

Ahead means commits reachable from the fork ref and not from the other ref.

## Fork-only commits on master

`git log upstream/master..origin/master` is 64 commits. Nine are merge commits. Fifty-five are non-merge commits. Grouped by theme:

### Upstream sync workflow

- `eba8147fd` ci: add weekly upstream sync from paperclipai/paperclip
- `fa47145a8` ci: sync-upstream and agent-runtime-images become dispatch-only

### Governance and onboarding docs

- `211e4f767` docs(governance): adopt projects-ops bootstrap baseline (Layer 1)
- `a6abc3000` docs(governance): adopt Paperclip baseline (#2)
- `258bd4793` docs: refresh onboarding guidance
- `48c6314e7` chore(governance): backfill wave 3 hygiene baseline
- `30ec00397` chore: close governance audit follow-up
- `79f99a246` docs: archive completed tracking task
- `d763de81b` docs: track windows pre-commit follow-up

### Pre-commit gates

- `ff0c07540` chore(repo): add pre-commit checks and onboarding guide
- `a6ffcff40` chore: add react doctor pre-commit gate

### UI: environment-scoped adapter model refresh

- `b2320805c` fix(ui): scope adapter model refresh by environment (#4)

These four files still differ between `origin/master` and `upstream/master`: `ui/src/api/agents.ts`, `ui/src/api/agents.test.ts`, `ui/src/components/AgentConfigForm.tsx`, `ui/src/lib/queryKeys.ts`. `agents.test.ts` matches `dev`. The other three differ between `dev` and `master`. The reconcile has to preserve environment-scoped refresh.

### Release dry-run and Playwright CI

- `5eaa8cefe` ci: reset tracked changes before release dry run
- `a2d0d55ec` ci: clean untracked files before release dry run
- `316aadaee` ci: ignore crlf-only release dirtiness
- `f2a04f3b4` ci: avoid playwright dependency install hang
- `91550d73c` ci: run playwright install through pnpm
- `59d9096b1` ci: use runner chrome for playwright e2e

### Privacy

- `dc2a48869` docs: neutralize getting-started attribution
- `ed83e1dc8` docs: neutralize internal workspace paths

Both commits touch the onboarding guide. That file still differs from upstream, and `dev` still differs from `master` on it. Keep the neutralized attribution and paths; the two commit IDs above identify the exact file.

### Tree snapshot (do not replay)

- `b2955e099` Review: orphaned test-runtime hardening (7 files, Codex estate) (#50)

Keep the real fork delta inside this tree. Leave the snapshot commit itself out of the reconcile. Replaying it is what produces the add/add conflicts.

### CI review gates, lockfile policy, secret scan

- `e5f0424ec` fix(ci): restore default-branch lock and PR review gates (#54)
- `b791094f6` fix(ci): authenticate trusted pull-request reviews on forks (#75)
- `696fed5e3` fix(ci): scan only the PR commit range for secrets (#177)

### Self-hosted runner and fork CI policy (2026-10-22)

- `ba131e2c8` ci: move push/PR jobs to rf-paperclip with same-repo fork guard
- `e412e1396` ci: fail fork PRs in verify/e2e, move commitperclip-review to pull_request on rf-paperclip, keep agent-runtime-images hosted
- `3ee5949be` ci: box-safe e2e and storybook lanes
- `9cc74c230` ci: pin actions to full SHAs, check out PR base for commitperclip token scripts
- `6c790c4d8` ci(docker): run default-branch image builds on the isolated box-img runner
- `c77d4b356` ci(release): run release-verify and the stable dry-run on rf-paperclip
- `3d79ea50e` ci(commitperclip): fail Dependabot PR reviews instead of passing without a gate signal
- `063fc8b4a` ci(release): publish_canary and publish_stable run only on workflow_dispatch
- `fa5b2143a` test(release): match the channel-gated verify_canary and verify_stable conditions
- `94c0f84f3` ci(commitperclip): persist-credentials: false on the second trusted base checkout
- `219a43a5c` ci: budget 45 min of rf-slot hook wait in every box job timeout
- `c124d7b00` ci(e2e): kill leftover e2e processes and the port 3199 listener by exact PID
- `7963ed92b` ci(commitperclip): run on ubuntu-latest, never on the box runner
- `4834cc2e8` ci(pr): never schedule a fork run of the verify and e2e aggregates on the box
- `49c41f45f` ci: persist-credentials: false on every read-only box-runner checkout

### HTTP log redaction and local port owner

- `7547110fb` fix(server): port hardened HTTP log redaction to master
- `8a10bce09` test(server): mock fetch before Smoke Lab startOAuth so discovery never hits the network
- `b3b029122` fix(server): fall back to ss for the local service port owner when lsof is missing
- `ddc2fe581` test(server): run the pnpm-wrapper adoption service through node explicitly
- `b721ab3c8` fix(server): strip raw res.err message and stack from HTTP logs
- `f6abdb7a9` fix(server): redact /api/invites/<token> path segment in HTTP logs
- `10ea01adc` fix(server): redact value of sensitive {name, value} header records
- `17543acc8` fix(server): build HTTP log msg from originalUrl so mounted /api paths redact
- `5cd991c6d` fix(server): redact credential HTTP headers by name pattern
- `e72af7c84` style(server): drop trailing blank line in http-log-redaction.ts
- `6b583e9ca` fix(server): accept only ports 1-65535 and an end-anchored pid in the ss port owner lookup
- `a0ca4b57d` fix(server): bound each port owner lookup tool with a 5s execFile timeout

### E2E owned cleanup

- `7a607d54c` ci(e2e): clean up only this job's e2e processes and home dir
- `4c915e208` test(e2e): keep the owned-cleanup test out of the real /tmp
- `966d097ec` ci(e2e): pass the owned home as PAPERCLIP_E2E_HOME, keep TMPDIR short

### Public PR checks and lockfiles

- `32c45ecac` ci: isolate public PR checks and preserve regenerated lockfiles (#203)

### Merge commits

These joins carry the themes above. They are not extra product changes.

- `ca223c802` Merge remote-tracking branch 'origin/master'
- `0945481be` Merge branch 'agent/antigravity/1-adopt-governance-baseline' into master
- `154f42270` Merge pull request #8 from iMelki/dev
- `76ee94598` Merge pull request #43
- `c34072571` Merge pull request #44
- `4f4c07835` Merge pull request #188
- `0c8d2ec45` Merge pull request #189
- `d07bd93da` Merge pull request #184
- `b942cb5d6` Merge pull request #192

## Conflict map

Trial command, in a detached scratch worktree at `origin/master`. The worktree was removed after the count. No commit was created.

```sh
git merge --no-commit upstream/master
```

Exit code 1. `MERGE_HEAD` was `267983356c6e3c4d5210f106b7b78ec2fa74f1b1`.

| Result | Count |
| --- | ---: |
| Unmerged paths | 1769 |
| Paths that contain conflict markers | 1738 |
| Conflict hunks (`<<<<<<<`) | 17213 |
| Clean adds from upstream | 12078 |
| Clean modifications | 389 |
| Clean deletes | 69 |
| Clean renames | 11 |

Unmerged states: 1057 add/add (`AA`), 698 content (`UU`), 12 modify/delete (`UD`), 1 delete/delete (`DD`), 1 added-by-us/deleted-by-them (`UA`).

During the merge, Git warned `upstream/master is not a valid attribute name: .gitattributes:16`. The in-progress `.gitattributes` has conflict markers, and line 16 is the upstream marker. That warning is the marker, not an extra conflict. Fork `.gitattributes` sets `eol=lf`. Upstream `.gitattributes` sets `patches/*.patch whitespace=-space-before-tab`. Keep both rules when that file is resolved.

### By top-level directory

| Area | Unmerged | Add/add | Content | Other |
| --- | ---: | ---: | ---: | --- |
| `ui` | 650 | 413 | 232 | 5 modify/delete |
| `server` | 513 | 290 | 219 | 4 modify/delete |
| `packages` | 404 | 240 | 162 | 1 delete/delete, 1 UA |
| `cli` | 43 | 21 | 22 | |
| `scripts` | 37 | 27 | 9 | 1 modify/delete |
| `doc` | 33 | 19 | 12 | 2 modify/delete |
| `.github` | 17 | 9 | 8 | |
| `docs` | 17 | 4 | 13 | |
| `tests` | 17 | 13 | 4 | |
| `.agents` | 13 | 11 | 2 | |
| `skills` | 7 | 4 | 3 | |
| `docker` | 4 | 3 | 1 | |
| `.claude` | 1 | 1 | 0 | |
| repo root | 13 | 2 | 11 | |

Root add/add: `.gitattributes`, `DESIGN.md`. Root content: `.env.example`, `.gitignore`, `AGENTS.md`, `CONTRIBUTING.md`, `Dockerfile`, `README.md`, `ROADMAP.md`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`.

### Largest second-level areas

| Area | Unmerged |
| --- | ---: |
| `ui/src` | 639 |
| `server/src` | 511 |
| `packages/adapters` | 122 |
| `packages/shared` | 106 |
| `packages/plugins` | 70 |
| `cli/src` | 40 |
| `packages/adapter-utils` | 39 |
| `packages/db` | 36 |
| `packages/teams-catalog` | 15 |
| `tests/e2e` | 14 |
| `.agents/skills` | 13 |
| `.github/workflows` | 10 |
| `ui/storybook` | 8 |
| `packages/skills-catalog` | 7 |

`packages/db` (36 paths) is the migration and schema overlap. Resolve it with a reviewer. Keep migration numbers unique and keep applied migrations idempotent.

These conflicts do not resolve with a single ours/theirs choice. Add/add is the snapshot. Content conflicts are later edits on both sides. A mechanical take-upstream pass would drop the fork CI and redaction patches.

### Read-only check of dev

This was `git merge-tree --write-tree --no-messages --name-only origin/dev upstream/master`. It was not a worktree merge, and it did not write a commit. It reported 244 conflicted paths:

| Area | Paths |
| --- | ---: |
| `server` | 121 (`server/src` 120, `server/package.json` 1) |
| `packages` | 58 |
| `ui` | 32 (all `ui/src`) |
| `.github` | 9 |
| `cli` | 5 |
| `scripts` | 5 |
| repo root | 5 |
| `doc` | 3 |
| `docs` | 2 |
| `patches` | 2 |
| `skills` | 2 |

Inside `packages`: `packages/adapters` 16, `packages/db` 16, `packages/shared` 13, `packages/adapter-utils` 9, `packages/plugins` 3, `packages/paperclip-runner` 1.

244 is under 300 paths. The paths are still content conflicts in application source. They do not resolve mechanically, so this change does not open the merge pull request. The master trial (1769) is the gate in the task, and it is over the limit.

## Fork changes that must be kept

Preserve behavior. The reconcile can rebuild that behavior as patches on upstream history.

Keep these. They are fork policy and they are absent from upstream as files, or they still differ:

- Sync workflow, after the conflict-PR fix in this branch: `.github/workflows/sync-upstream.yml`
- Fork CI policy from the 2026-10-22 runner migration and from `#54`, `#75`, `#177`, and `#203`: self-hosted `rf-paperclip` for box jobs, `box-img` for default-branch image builds, hosted runners where the job must stay off the box (`commitperclip` review, and any public-repo job that only calls the GitHub API), SHA-pinned actions, same-repo fork guards, no `pull_request_target`, secret scan limited to the PR range, trusted review auth on forks, dispatch-only release publish, `persist-credentials: false` on read-only checkouts, 55 minute timeouts that include the box slot wait, and public PR check isolation with regenerated lockfiles kept
- Fork-only CI and governance files that are on `master` and absent from the upstream tip (rename detection was skipped, so treat this list as paths, and confirm renames during the reconcile): `.github/workflows/pr-retarget-secret-scan.yml`, `.github/workflows/sync-upstream.yml`, `.github/ISSUE_TEMPLATE/agent_task.md`, `.github/labels.yml`, `.github/scripts/check-fork-dependency-policy.mjs`, `.github/scripts/check-pr-security.mjs`, `.github/scripts/ci-lockfile-transfer.mjs`, `.github/scripts/select-review-token.mjs`, and their tests, plus `OPEN_TASKS.md`, `.coderabbit.yaml`, `.gitleaksignore`, `.gate-evidence.json`
- HTTP log redaction and the bounded `ss` port-owner lookup. On `dev`, these files already match `master`: `server/src/middleware/http-log-policy.ts`, `server/src/middleware/http-log-redaction.ts`, `server/src/middleware/http-logger.ts`, and the three matching tests. Keep that behavior when upstream logger files conflict. Re-check `server/src/middleware/logger.ts`, `server/src/middleware/redact-sensitive.ts`, `server/src/services/local-service-supervisor.ts`, and `server/src/__tests__/redact-sensitive.test.ts`, which still differ between `master` and `dev`
- E2E owned cleanup (`scripts/ci/e2e-owned-cleanup.sh` and its test)
- Privacy text in the onboarding guide identified by commits `dc2a48869` and `ed83e1dc8`
- Environment-scoped adapter model refresh (`#4`)
- Governance docs and pre-commit gates that are still unique to the fork (`AGENTS.md` portfolio section, onboarding, react-doctor pre-commit)

`origin/master` is 47 files away from the snapshot commit. 38 of those still differ between `master` and `dev`. Those 38 are the concrete port from master-only history onto a dev-based reconcile. They are the CI workflows and scripts listed above, the e2e cleanup scripts, the redaction files that still differ, `pnpm-lock.yaml`, `CHANGELOG.md`, and `.gitleaksignore`. The onboarding guide is separate from this 47 (it predates the snapshot). Let the lockfile refresh workflow regenerate `pnpm-lock.yaml`. Do not hand-merge that file into a commit.

About 264 paths are present on fork `master` and absent from the upstream tip, with rename detection skipped. The important ones are the `.github` policy files, `OPEN_TASKS.md`, and the fork ignore and evidence files above. Many of the other 264 will be renames or files `dev` already carries. Confirm them on the reconcile branch. Do not delete a fork-only policy file because upstream lacks it.

## Recommended path

1. Reconcile custody and use an existing authorized branch based on current `origin/dev`; do not create a new branch or worktree for this task.
2. Merge `upstream/master` into that branch and stop before pushing a conflicted tree.
3. Resolve in this order:
   - `.github`, root policy files, and `AGENTS.md` / `CONTRIBUTING.md`. Keep the fork CI and governance behavior listed above.
   - `packages/db`. Keep both migration histories. Renumber a fork migration when upstream took the same number. Make the SQL idempotent.
   - `server/src`, then `packages/*`, then `ui/src`. Prefer upstream product behavior. Re-apply redaction, port-owner lookup, and environment-scoped model refresh on top.
   - `docs/` and `doc/`. Keep the neutralized getting-started text.
   - `pnpm-lock.yaml` by regeneration, after the package manifests are resolved.
4. Port the master-only behaviors that `dev` does not already match (the 38-file set and the privacy doc).
5. Open that branch as a draft pull request into `dev`.
6. After `dev` is green, promote `dev` to `master` through the normal promotion. Leave `master` and `dev` untouched until that promotion.

The revised workflow removes the direct-to-master path. Each dispatch verifies the upstream SHA and reconcile branch before preparing a draft into `dev`, even when GitHub could merge cleanly. Do not use the pointer draft as the promotion vehicle.

`dev` still carries the old scheduled workflow (`cron` Monday 04:00 UTC, `ubuntu-latest`, `contents: write` only, `core.setFailed` on 409). This branch replaces that file. The default branch is `master`, so dispatch on `master` keeps the old 409 failure until this fix is promoted.

Open pull request #267 (`agent/cto/paperclip-master-into-dev` into `dev`) already brings the current `master` copy of this workflow onto `dev`, together with other master-only CI files. That copy still fails the job on HTTP 409. Keep the draft-PR behavior from this branch if the two pulls conflict. #267 is the right review for the 44 master-only commits. It is not the upstream merge.

## Workflow fix in this change

Same commit as this plan. The job stays `workflow_dispatch` on `[rf-paperclip]` with a 55 minute timeout. Permissions gain `pull-requests: write`. There is no `pull_request_target` trigger and no schedule.

On each explicit dispatch:

1. Read and validate the full upstream master SHA. Do not update fork master.
2. Look for an open same-repository pull request into dev with that SHA and a valid sync branch. Re-read its actual branch SHA before reusing it.
3. Create the dated sync pointer ref, or tolerate only the specific already-exists response. In both cases read back the ref and require the exact intended SHA before creating a pull request. Other failures stop the job.
4. Create a draft into dev and verify its returned head repository, ref, SHA, base and draft state. A concurrent movement after the branch read cannot be prevented atomically by the pull-request API; a returned mismatch is an explicit investigation failure, never a successful sync.
5. If a pull-request-already-exists response occurs, independently verify both the branch and matching current pull request. Do not infer success from the response text alone.

If GitHub reports no commits between base and head, the dispatch fails without creating a pull request. A ref already created by this attempt is retained; no branch deletion, automatic cleanup or blind write retry occurs. Reconcile its disposition before another write.

The pointer draft may show conflicts and is not ready to merge. Same-repository checks may start when the draft is created. Creating that draft can therefore consume runner resources or invoke review providers: dispatch requires the existing no-extra-spend admission; merging this source change does not authorize a dispatch or a paid wake.

## Out of scope for this change

- The 1769-path merge into `master`
- A draft merge pull request into `dev` (the conflict count is over the limit, and the dev merge-tree conflicts are not mechanical)
- Direct pushes to `master` or `dev`
- History rewrite, rebase of shared branches, or force-push

- CTO (grok-bot-cto)
