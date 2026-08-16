# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Before You Start: Search First

Before you start work, **search GitHub** for existing PRs and issues that touch the same area:

- Look for **duplicate or in-flight PRs**. If something close already exists, prefer helping that PR over the line (see [Helping Other Contributors](#helping-other-contributors)) instead of opening a parallel one.
- Look for **related open issues**. Link them in your PR body.
- If an older PR is effectively dead (stale, unmaintained, would be painful to rebase/merge), a fresh PR is fine — just call out the prior PR in your description so the reviewer has context.

Duplicate PRs create extra work for reviewers and make merging harder. A 60-second search saves hours later.

Affirm that you did this search by checking the dedup-search box in the PR template (`I have searched GitHub for duplicate or related PRs and linked them above`). Commitperclip checks for this checkbox on non-trivial PRs.

## iMelki Fork Governance

This fork also follows the portfolio-wide governance baseline for AI/human agent work:

1. Create scoped work from `.github/ISSUE_TEMPLATE/agent_task.md` when assigning tasks to agents.
2. Link relevant docs, issues, PRs, and plans before implementation.
3. Classify work with risk, agent suitability, and allowed file scope.
4. Use labels from `.github/labels.yml`, including `domain:multi-agent` when applicable.
5. Maintain `OPEN_TASKS.md` as the local task index.

Use `dev` for active implementation in the owned fork. Promote reviewed work
from `dev` to `main`/`master` according to the repository's documented branch
policy; do not create agent or feature branches unless the operator grants a
specific exception.

Request human review for medium, high, and critical risk changes. Treat remote execution, sandboxing, model selection, heartbeat scheduling, billing, and credentials as high-risk areas that need focused tests.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Greptile score is 5/5 with all comments addressed
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Greptile score 5/5 with all comments addressed
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Link Issues or Describe Them In-PR

We do not gate PRs on a pre-existing issue. Two acceptable paths:

1. **Issue exists** — search the [Issues database](https://github.com/paperclipai/paperclip/issues) for anything this PR addresses and tag each one with `Fixes: #123` / `Closes #123` / `Refs #123` so GitHub auto-links them. If there are **duplicate or closely related issues**, link all of them, not just the one you picked. If there are **related PRs** (prior attempts, dependent work, follow-ups, abandoned predecessors), link those too.
2. **No issue exists** — describe the problem directly in your PR body, following one of our [issue templates](.github/ISSUE_TEMPLATE/) so a reviewer has the same fields they'd get from a filed issue:
   - **Bug fix:** what happened, expected behavior, steps to reproduce, Paperclip version/commit, deployment mode. See [`bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml).
   - **Feature:** problem/motivation, proposed solution, alternatives considered, roadmap alignment. See [`feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml).
   - **New adapter:** agent or provider, why it's useful, how it's invoked. See [`adapter_request.yml`](.github/ISSUE_TEMPLATE/adapter_request.yml).

Either way, a reviewer should be able to understand the underlying issue without leaving the PR. Commitperclip may check that one of these two paths is satisfied. Only link **public** GitHub issues — see [No Internal Issue References](#no-internal-issue-references) for what to leave out.

### No Internal Issue References

Many contributors run their own Paperclip instance to manage their work. Issue ids and links from *your* instance are private — reviewers and other contributors cannot open them, so they show up as clutter or broken links.

In your PR title, description, commits, and comments, **only reference public GitHub issues and PRs** — `#123`, `Fixes #123` / `Closes #123` / `Refs #123`, or full `https://github.com/paperclipai/paperclip/...` URLs.

Do **not** include references to internal/instance-local Paperclip work, such as:

- Internal ticket ids like `PAPA-123`, `PAP-224`, or any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number.
- Instance UI links such as `/PAP/issues/...`, `/PAP/agents/...`, `agent://...`, or document deep links.
- `localhost`, private IP, or tailnet URLs pointing at your own instance.

If an internal issue captured useful context, restate that context in plain English in the PR body instead of linking to it.

### Branch Naming

Tooling (including Paperclip) often names a working branch after an internal issue and task — e.g. `PAPA-42-why-did-this-break`. That name leaks instance-local context, isn't meaningful to reviewers, and ends up as the public branch on your PR.

Before you push, **rename the branch to something descriptive of the change itself**, not of your instance:

- Use short, kebab-case names scoped to the change, optionally with a conventional prefix: `docs/no-internal-issue-references`, `fix/sandbox-secret-resolution`, `feat/adapter-retry-backoff`.
- Do **not** include internal Paperclip ticket ids (`PAPA-123`, `PAP-224`), instance task slugs, or other instance-derived details in the branch name.

To rename and push under the new name:

```bash
git branch -m <descriptive-name>
git push -u origin <descriptive-name>
# If your tooling already pushed the old branch, delete it from origin:
git push origin --delete <old-name>
```

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

#### What the pre-commit hook runs

**Budget: p95 ≤ 90 s, hard cap 180 s.** A check that cannot meet that budget **moves to a
separately scheduled or CI exhaustive tier — it is never deleted.** The budget is written down so it can be defended: this
hook previously reached roughly 88 minutes (13 min `pnpm -r typecheck` plus a ~75 min full
suite) one "just this once" check at a time.

**This repo does not meet its own budget yet** — see the measurements below and
[#71](https://github.com/iMelki/paperclip/issues/71). The number stays as the target;
the gap is tracked rather than papered over by raising it.

The pre-commit hook is scoped to your staged change so it stays in the seconds-to-minutes range:

- **Typecheck** runs on the workspace packages your staged files touch, expanded to their
  dependents (`pnpm --filter ...<pkg> typecheck`). Staging a root build input — the root
  `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, a root `tsconfig*.json`, or
  `vitest.config.ts` — falls back to the full `pnpm -r typecheck` sweep.
- **Unit tests** run only the suites whose module graph reaches a staged file
  (`vitest --related`). A staged file no suite imports runs no tests and passes.
- **Forbidden tokens, Gitleaks, and React Doctor are unscoped and unchanged** — those gates
  still see every commit.

#### Where push verification happens

`.husky/pre-push` runs `scripts/pre-push-check.ps1` (or the `.sh` mirror): the workspace
link preflight, the forbidden-token check, the fail-closed adapter/runtime `git push`
scanner, the PR-trigger policy, full `pnpm -r typecheck`, and a deterministic exact-test
plan. The planner reads Git's four-field pre-push protocol rather than guessing from an
upstream branch. It accepts one pristine checked-out HEAD, verifies the exact push URL,
and bases a new topic branch on the destination's advertised `dev` object. Tests cover
the resulting current-tree paths; Gitleaks covers every commit in the exact range.

Changed test files run directly. Changed production files select only co-located or named
sibling suites; live production without a discoverable sibling is an explicit failure,
not an empty pass. A deleted test, or deleted production without a surviving sibling, is
assigned to hosted CI so deletion remains possible through a reviewed topic PR. Node test files use `node --test`; suites owned by
the root Vitest projects use `run-vitest-stable.mjs --files`; Playwright, unregistered
workspace, workflow, hook, manifest, and test-config changes are declared for hosted CI.
Those hosted-only changes may be pushed to a topic branch, but not directly to `dev` or
`master`. Documentation is explicitly non-production; every other changed path has a
local test or hosted-CI owner rather than falling through an empty plan.

`.github/workflows/pr.yml` runs on pull requests into both `master` and `dev`; it must not
run on every push to `dev`. Hosted CI owns Linux/POSIX behaviour, clean frozen-lockfile
installs, and exhaustive suites. Its secret scan uses the exact PR commit range. The known
24 historical fixture findings remain tracked in
[#68](https://github.com/iMelki/paperclip/issues/68) without making every dev PR red.

**If you disable or bypass the pre-push hook, you lose the local security scanners, full
typecheck, deterministic exact suites, and the direct-protected-branch CI policy.** A
missing `.husky/pre-push` looks exactly like a pass because the Husky shim exits 0 when the
hook file is absent.

To reproduce the full sweep on demand:

```bash
pnpm run test:run                          # full suite on its own
PAPERCLIP_PRECOMMIT_ALL=1 git commit ...   # full typecheck + full test suite at commit time
node scripts/run-vitest-stable.mjs --files path/to/exact.test.ts
node scripts/run-pre-push-tests.mjs --changed-file path/to/source.ts --target-ref refs/heads/topic --dry-run
```

#### Measured cost (2026-08-13, contended host: ~120 node processes, ~58% CPU)

| Stage | Leaf change (`ui/src/lib/activity-format.ts`) | Hub change (`server/src/services/heartbeat.ts`) |
| :--- | ---: | ---: |
| `--related` suites selected | 9 of 1130 | **159**, capped to 12 |
| `--related` run (wall) | 93.6 s | 304.8 s |
| Scoped typecheck, cold | 137.6 s | 168.5 s |
| Scoped typecheck, warm (incremental) | 68.6 s | — |

Reference points: full `pnpm -r typecheck` is **184.3 s** warm across all 32 workspace
packages, and the full suite is ~75 min.

Two things follow, and they are why pre-commit remains capped while pre-push uses exact suites:

- **Cost is import, not execution.** The capped 12-suite hub run spent **227.8 s of 262.7 s
  (87%) importing modules** and only 29.6 s executing tests — about 22-25 s per suite,
  scaling linearly with suite *count*. So an *uncapped* `--related` on a hub module (159
  suites) would cost more than the full suite it replaced, which amortizes imports across
  shards. Uncapped `--related` is not a cheaper full suite; it is a slower one with less
  coverage.
- **Scoping the typecheck buys less than it looks.** `pnpm -r` already runs packages in
  parallel, so the full sweep costs roughly the slowest package: 184.3 s for 32 packages
  versus 137.6 s for the single `ui` package. The saving comes from tsc's incremental
  cache (`ui/tsconfig.tsbuildinfo`), not from narrowing the package set.

### Telemetry Changes

If your change adds, removes, or modifies emitted telemetry events, update the [Telemetry Data Contract](packages/shared/src/telemetry/README.md) in the same PR. Keep clients emitting raw dimension values and avoid documenting or relying on private delivery details.

### Paperclip Gates Must Pass

All Paperclip CI gates (lint, typecheck, tests, build, and any other required checks) must be satisfied before a PR can be merged. Don't ask for a merge while gates are red — fix them first.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** before it can be merged, with:

- **No open P2 (or higher) comments**
- **No open recommendations**
- **No open follow-ups**

We hold the bar high here on purpose — we want code quality to be as high as possible. If Greptile leaves comments, fix them (or, if a comment is wrong, reply explaining why) and request a re-review.

## Helping Other Contributors

Fixing up someone else's stalled or almost-there PR is **strongly encouraged**. If a contributor has done most of the work but ran out of time or got stuck, picking up their branch, polishing it, and getting it over the line is one of the most valuable things you can do here.

When you do:

- Give credit. Mention the original author in the PR description and thank them.
- Preserve their commits where reasonable — don't squash them out of existence.
- Be kind in comments and reviews. People put real effort into their PRs, even the ones that didn't quite land.

A culture where contributors help each other ship is worth more than any single PR. Be generous with thanks.

## Feature Contributions

We actively manage the core Paperclip feature roadmap.

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [ROADMAP.md](ROADMAP.md) first
- Start the discussion in Discord -> `#dev` before writing code
- If the idea fits as an extension, prefer building it with the [plugin system](doc/plugins/PLUGIN_SPEC.md)
- If you want to show a possible direction, reference implementations are welcome as feedback, but they generally will not be merged directly into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Write all PR text in Simplified Technical English (ASD-STE100): use short sentences, one instruction per sentence, simple approved vocabulary, and the active voice.

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip is the open source app people use to manage AI agents for work
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip is the open source app people use to manage AI agents for work
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Questions? Just ask in #dev — we're happy to help.

Happy hacking!
