# Refresh the lockfile for a branch

The Refresh Lockfile workflow accepts two manual inputs. `ref` selects the code
to check out. `base` selects the pull request destination. Both default to `dev`.
The workflow uses `chore/refresh-lockfile-<base>` and reuses an open PR only when
its head, base and repository owner match. A base containing `/` retains that
slash in the refresh branch. Invalid branch names fail before commit or push.

After the maintainer merges the fix into `dev` and releases the restart merge
freeze, dispatch the **dev version of the workflow**:

```sh
gh workflow run refresh-lockfile.yml --repo iMelki/paperclip --ref dev -f ref=dev -f base=dev
```

`--ref dev` selects the workflow file. `-f ref=dev` selects the checkout. These
are separate controls. Without `--ref`, this command uses the workflow file from
the default branch (`master`):

```sh
gh workflow run refresh-lockfile.yml -f ref=dev -f base=dev
```

Use that shorter command only after the updated workflow also reaches `master`.
The workflow already exists on the default branch, which is required for manual
dispatch discovery. No dispatch is part of this implementation lane.

For a patch PR that needs its own updated hash, set `ref` to that PR's branch and
keep `base=dev`. The resulting refresh branch starts from that source ref; review
its complete diff before merging. A plain `ref=dev` dispatch cannot include a
patch that has not yet landed in `dev`.

Find the dispatch run, record its ID, and inspect its log and PR:

```sh
gh run list --repo iMelki/paperclip --workflow refresh-lockfile.yml --branch dev --event workflow_dispatch
gh run view <run-id> --repo iMelki/paperclip --log
gh pr list --repo iMelki/paperclip --state open --head chore/refresh-lockfile-dev --base dev
gh pr view <pr-number> --repo iMelki/paperclip --json headRefName,baseRefName,files,autoMergeRequest
```

Check that the saved PR has the expected head, base, owner and file diff. Dev
refreshes require maintainer review and do not enable auto-merge. An unchanged
lockfile produces no PR. Master pushes still refresh their exact triggering
commit, target `master`, and enable auto-merge. Their work branch is now
`chore/refresh-lockfile-master`; existing legacy refresh branches are not changed.
The existing force-push is confined to the selected base's work branch.

## Local verification

```sh
actionlint -shellcheck= .github/workflows/refresh-lockfile.yml .github/workflows/pr.yml
node --test scripts/refresh-lockfile.test.mjs .github/scripts/tests/check-pr-lockfile.test.mjs
```

The dependency-free Node tests run the actual workflow shell with Git writes
and GitHub calls intercepted. They require Bash and jq on PATH. They use real jq
for the repository-owner filter and real Git for branch-name validation. The
tests cover dev/master selection, wrong-head/base/fork PRs, no-op refreshes,
invalid branches, unexpected file changes and both lockfile review gates. They
do not run pnpm or publish a lockfile PR. Live Actions proof remains a maintainer
step after merge.

## Research

- [GitHub workflow dispatch inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)
- [Checkout ref input](https://github.com/actions/checkout#usage)
- [GitHub CLI PR creation base](https://cli.github.com/manual/gh_pr_create)
- [GitHub CLI PR list head and base filters](https://cli.github.com/manual/gh_pr_list)
- [Manual workflow runs and --ref](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [CLI issue 10945: head does not support owner-qualified syntax](https://github.com/cli/cli/issues/10945)
- [Community discussion 25412: workflow definitions on different branches](https://github.com/orgs/community/discussions/25412)
- [Fork issue 164](https://github.com/iMelki/paperclip/issues/164)
- [PR 165 maintainer note](https://github.com/iMelki/paperclip/pull/165#issuecomment-6046955419)
