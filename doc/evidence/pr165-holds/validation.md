# PR #165 hold evidence, 2026-10-08

The delegated comparison and recommendation are complete. The lockfile hold remains
open until the acting CTO dispatches and reviews the bot PR. This evidence branch
changes documentation only; it does not alter PR #165, dependencies or runtime code.

## Exact candidates

- Repository: `iMelki/paperclip` (public fork).
- Plain dev: `0d394a198518571b3163e2c55a55f453bf5e1946`.
- PR #165 head: `f767e92bec2fbf87ea65ed7595f1f0c636b982fb`.
- PR branch: `agent/codex/162-acpx-typed-failure-patch`; base: `dev`.
- Implementation patch ID, excluding changelog and gate ledger:
  `74002e69e9bcd02ae4eddb25c14faf0d302046af`.
- Patch SHA-256: `0016168dabdce86a1d9a1b6b447a2d5ddd1df6f7527c45f496497e04b94b2d3b`.
- Both packaging test blobs: `227c77695b759eb1fdfc8826c7cf759a2913587c`.

The GitHub head and remote dev were read again after testing and were unchanged.
`git merge-tree --write-tree origin/dev origin/agent/codex/162-acpx-typed-failure-patch`
exited 0, producing tree `7b216a7e53772d99ef6a6186214fc1c6b17336d5`.
GitHub reports MERGEABLE. No merge or rebase of dev is needed for a clean merge.
The restart delivery is independently recorded on agent-settings #1646; #164 is
closed and PR #166 is merged. These are readbacks, not actions by this lane.

## Packaging comparison: hold 3

Command in each exact, unmodified source worktree:

```sh
node --test --test-reporter=tap scripts/acpx-patch-packaging.test.mjs
```

| Candidate | Passed | Failed | Skipped | Exit | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain dev | 7 | 1 | 0 | 1 | 399.360 ms |
| PR head | 7 | 1 | 0 | 1 | 232.0645 ms |

Both fail the same sixth case, `bundled package staging rebuilds npm dependencies
and applies the acpx patch`, before the staging helper runs. The fixture passes
`new URL(...).pathname` to Node; Windows drive-prefix resolution causes
`MODULE_NOT_FOUND`. This predates PR #165. Dedicated issue [#167] owns the repair
under umbrella [#22]. Its complete 4,042-character body was read back byte-for-byte.
The test suite remains red; this establishes attribution rather than a repair.

Initial dependency-free probes failed during import because embedded-postgres was
missing (0 pass, 1 file-level failure). Those outputs are retained locally and
excluded from the qualified 8-test comparison. Plain dev prerequisites were installed
with a filtered frozen install. The PR's filtered frozen install correctly refused
the stale patch/lockfile configuration (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, exit 1).
Its tracked lockfile was never changed.

The PR worktree uses junctions for root, adapter-utils and db node_modules pointing
only into an owned scratch copy of that exact PR source. The scratch lockfile was
regenerated before filtered installation. This installs the real PR patch directly;
there was no runtime overlay and no shared runtime/store mutation. The db dependency
version and its patch are identical on dev and the PR. Both tracked worktrees were
clean after testing. Sanitized complete TAP logs are retained beside this report;
host paths are masked, with test names, codes, counts and timings preserved.

## Lockfile regeneration: hold 2

Scratch was extracted from `git archive` of the exact PR head. Commands:

```sh
corepack pnpm@9.15.4 install --lockfile-only --ignore-scripts --no-frozen-lockfile --store-dir <owned-scratch-store>
git diff --no-index -- <pr-copy>/pnpm-lock.yaml <scratch-copy>/pnpm-lock.yaml
```

Regeneration exited 0 (pnpm duration 5.6 s; 1,395 resolved, zero downloaded).
The comparison exits 1 because it found a diff. Only three lines change:

1. `patchedDependencies.acpx@0.12.0.hash`.
2. `importers.packages/adapter-utils.dependencies.acpx.version` patch-hash reference.
3. The `snapshots.acpx@0.12.0(patch_hash=...)` key.

All three change `x3fethhotv43zektyl5prdwf54` to `ff4k243ql73jzgvwxkxl4vmbdy`.
No package resolution or manifest changed. See [lockfile.diff](lockfile.diff).
Existing peer warnings mention the claude SDK's zod/anthropic SDK requirements and
better-call's zod requirement; no dependency repair is included here.

### Recommended route: dispatch the dev workflow with the PR source ref

The acting CTO, after re-reading the source branch head, should run:

```sh
gh workflow run refresh-lockfile.yml --repo iMelki/paperclip --ref dev -f ref=agent/codex/162-acpx-typed-failure-patch -f base=dev
```

`--ref dev` chooses the fixed workflow definition. The input `ref` chooses the source
checkout containing the unmerged patch. The input `base` chooses the PR destination.
No workflow was dispatched by this lane.

The workflow would create/update `chore/refresh-lockfile-dev` from the PR source
branch, commit the regenerated lockfile, and create/reuse an owner-matching PR
against `dev`, titled `chore(lockfile): refresh pnpm-lock.yaml`. No such open bot PR
existed at readback. Its future number cannot be known before creation.

The lockfile commit itself contains only the three hash-reference replacements.
The **complete bot PR diff against dev** also contains PR #165's five files:
`.gate-evidence.json`, `CHANGELOG.md`, `patches/acpx@0.12.0.patch`,
`scripts/mcp-fixtures/servers/acp-echo-agent.mjs`, and
`packages/adapter-utils/src/acpx-engine/typed-failure.test.ts`. Together with
`pnpm-lock.yaml`, that is six files. The workflow's generated body says it only
updates the lockfile, so the CTO must assess the complete source-inclusive diff.
This is explicitly described in `doc/LOCKFILE_REFRESH.md` for a ref differing from
base. It is one typed-failure theme and permits source plus matching lockfile to
land atomically through the bot PR, subject to exact-head review and normal checks.

Both review gates require `github-actions[bot]` on the exact
`chore/refresh-lockfile-dev` branch for a lockfile-changing PR to dev. A hand-edited
lockfile on #165 would fail policy. Refreshing `ref=dev` before the patch lands cannot
produce this hash. Dev refreshes do not enable auto-merge. The workflow's existing
force-push is confined to its bot branch; this lane did not push that branch.

After dispatch, the CTO owns saved run/PR readback, exact head/base/author/file diff
inspection, dependency approval, review and merge disposition of #165 versus the
source-inclusive bot PR. No source branch was changed, marked ready or labelled.

## Focused PR verification and installation

```sh
corepack pnpm@9.15.4 --filter @paperclipai/db install --frozen-lockfile --ignore-scripts --store-dir <owned-dev-store>
corepack pnpm@9.15.4 --filter @paperclipai/db install --frozen-lockfile --ignore-scripts --store-dir <owned-pr-store>
corepack pnpm@9.15.4 --filter paperclip --filter @paperclipai/adapter-utils --filter @paperclipai/db install --frozen-lockfile --ignore-scripts --store-dir <owned-scratch-store>
corepack pnpm@9.15.4 exec vitest run packages/adapter-utils/src/acpx-engine/typed-failure.test.ts --project @paperclipai/adapter-utils --maxWorkers=1 --no-file-parallelism --reporter=verbose
npm.cmd pack acpx@0.12.0 --pack-destination <owned-tarball-directory> --json
git apply --check <exact-pr-patch>
```

- Dev filtered frozen install: exit 0, 148 dependencies, 21.7 s.
- PR filtered frozen install: exit 1, patch/lockfile mismatch, no tests run.
- Scratch filtered frozen install: exit 0, 172 dependencies, 22.9 s.
- Focused file run from the exact PR worktree: 8 passed, 0 failed/skipped, exit 0,
  12.44 s. Both terminal-error modes fail the turn, initialize records advertise
  sessionFailure, warning modes succeed, and both callback APIs preserve complete
  diagnostics on consecutive turns.
- Published acpx tarball extraction and candidate `git apply --check`: exit 0.
- Historical negative proofs in #165's existing gate ledger were read; this lane
  changed no gate or discriminator and did not recreate their historical counts.

An initial tar extraction using backslash relative arguments hit the installed
POSIX tar's path parsing and failed; the corrected forward-slash invocation passed
before the patch check. That failed attempt is retained locally and excluded from
the successful patch applicability proof.

No full application build, typecheck, wider engine cohort or live provider run was
performed by this lane. The PR's prior broad local and hosted outcomes remain their
own evidence; they are not represented as fresh passes here.

## Operational bounds

Host admission immediately before installation: RAM used 62.032%, 24,763 MB
available, commit charge 51.791%; both are below the delegated 92% limits.
TEMP/TMP/TMPDIR were one fresh lane-specific directory under the designated local
temporary root. Nothing was created on the constrained workspace drive.
`core.hooksPath` is unset and only sample hooks exist in this fresh clone. No hook
was bypassed. No service, scheduler, registry, ACL, instance or other agent process
was changed. The clone's origin is the owned fork and upstream is the external
parent; all public writes target only the fork. MemSys recall returned low-relevance
evidence and was not used for any conclusion.

## Research

- [PR #165 and maintainer holds](https://github.com/iMelki/paperclip/pull/165).
- [Typed-failure umbrella #162](https://github.com/iMelki/paperclip/issues/162).
- [Closed route gap #164](https://github.com/iMelki/paperclip/issues/164).
- [Merged workflow fix #166](https://github.com/iMelki/paperclip/pull/166).
- [Fixed workflow at dev](https://github.com/iMelki/paperclip/blob/0d394a198518571b3163e2c55a55f453bf5e1946/.github/workflows/refresh-lockfile.yml).
- [Lockfile policy at dev](https://github.com/iMelki/paperclip/blob/0d394a198518571b3163e2c55a55f453bf5e1946/.github/workflows/pr.yml).
- [Refresh procedure at dev](https://github.com/iMelki/paperclip/blob/0d394a198518571b3163e2c55a55f453bf5e1946/doc/LOCKFILE_REFRESH.md).
- [Node native URL path conversion](https://nodejs.org/api/url.html#urlfileurltopathurl-options).
- [pnpm install options](https://pnpm.io/cli/install).
- [GitHub manual workflow run and ref selection](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
- [Community discussion of workflow definitions on separate branches](https://github.com/orgs/community/discussions/25412).

Official documentation and exact repo source determine the recommendation; the
community discussion is supporting context. No new reusable shared primitive is
needed: native fileURLToPath and the merged refresh procedure already cover the
mechanisms. The unresolved fixture repair is owned by #167.

[#167]: https://github.com/iMelki/paperclip/issues/167
[#22]: https://github.com/iMelki/paperclip/issues/22

Delegated by the acting CTO (Claude) to a Codex lane.

Fresh dev routing/policy command: `node --test --test-reporter=tap scripts/refresh-lockfile.test.mjs .github/scripts/tests/check-pr-lockfile.test.mjs`: 21 passed, 0 failed/skipped, exit 0, 1.113 s. The real workflow shell is exercised with Git writes and GitHub calls intercepted; no dispatch or bot publication is claimed.
