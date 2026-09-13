# PR117 bounded correction

Status: parent-approved for publication checkpoint on 2026-09-13, not merge.
Parent independently reran the exact Node command: 9 passed, 0 skipped,
35.2 ms, and clean diff check. Normal hooks remain required for commit/push.
Issue: [#35](https://github.com/iMelki/paperclip/issues/35).
Original PR head: `7bab6d10ea3ef1a8cdda437bba13d58dcae8b0b2`.
Compared base: `9f4a7e0aa99cd964fe7cd8913981500cc8f13d2f`.

## Change and proof

- Both Windows pg_ctl spawns register `once('error', reject)` and set `windowsHide: true`.
- Original `postgresFlags` join semantics remain unchanged. Tests cover ordinary
  flags only; there is no new quote transformation or claim of safe CMD escaping.
- `pnpm-lock.yaml` matches current base, including removal of the unrelated Babel version change.
  Blob: `b8265b395be328934b4cdba5d4c527fa8fa5df90`.
  Current `.github/workflows/pr.yml` regenerates and uploads a lockfile for `^patches/` changes.
- `node --test --test-isolation=none scripts/embedded-postgres-pgctl.test.mjs`:
  9 passed, 0 failed; 28.6977 ms on the final 2026-09-13 proof run.
  The initial harness run failed because extraction included an unrelated hunk;
  extraction now selects each lifecycle hunk independently.
- `node --check scripts/embedded-postgres-pgctl.test.mjs`,
  `git apply --numstat patches/embedded-postgres@18.1.0-beta.16.patch`,
  and `git diff --check` passed.
  That focused run needed no dependencies, database, elevated process, or build.
- The existing policy job now explicitly invokes the same Node test command.
  Root Vitest projects do not discover scripts. Node 24 is already configured
  in that job; no new dependency, matrix, or workflow is introduced.
- Negative proof: both windowsHide flags were temporarily false (asserted twice).
  The command exited 1 with six failures naming start/stop windowsHide, then
  exited 0 after restoration. Raw output: [failure](../evidence/pr117/negative-final.log)
  and [pass](../evidence/pr117/pass-final.log). `.gate-evidence.json` records the
  command, reason, exit codes, and matching pre/post SHA256.
  Earlier negative.log/pass.log are retained historical receipts from the
  superseded quoting candidate, not evidence for the final patch.

The tests execute the added lifecycle blocks from the patch with mocked spawn,
filesystem, and platform dependencies. They cover ENOENT/EACCES rejection for
both operations, nonzero exits, startup arguments/logs/PID, graceful stop,
and POSIX stop. They do not prove patch application to a clean npm package,
full module integration, or native Windows child behavior.

## Review and remaining gates

Additional merge HOLD: existing pg_ctl `-o` forwarding needs dedicated native
Windows command-line proof. Parent research shows PostgreSQL 18 wraps post_opts
in `ComSpec /C` (pg_ctl.c lines 517-522). CRT-only escaping does not establish
safe CMD handling of quotes, percent expansion, exclamation marks, or shell
metacharacters. The proposed quote map was removed; no custom escaping is added.

[Independent parent review](https://github.com/iMelki/paperclip/pull/117#issuecomment-5648622603)
confirms the original patch is not superseded. Current dev still uses direct
postgres startup and taskkill shutdown. The correction is committed on
the existing PR branch, approved by the parent for publication only.
Canonical dev remains clean and unchanged (0 ahead / 0 behind origin/dev).
Command-scoped `core.hooksPath=.husky` invokes tracked original hooks because
this worktree lacks `.husky/_/pre-commit`; shared Git configuration is unchanged.

### Historical prerequisite failures

Publication attempt on 2026-09-13: the normal tracked pre-commit hook ran via
`git -c core.hooksPath=.husky commit` and exited 1. Its workspace-link preflight
requires `cli/node_modules/tsx/dist/cli.mjs`, which was absent in this worktree.
Token and pinned Gitleaks checks passed. No commit was created and push was not
attempted. No bypass, dependency install, or shared configuration change occurred.
Durable log: sibling directory `../paperclip-pr117-publication-logs/commit.log`;
exit receipt: `../paperclip-pr117-publication-logs/commit-status.log` (exit 1).
The pre-push hook also requires workspace dependencies and full `pnpm -r typecheck`.
Read-only admission snapshot: 17,954,072 KiB free of 66,786,036 KiB total
(73.1 percent used). Missing dependencies blocked that attempt, not authorization.
Captured Node logs have whitespace-only blank lines normalized for Git diff checks;
assertion text and results are unchanged.

Offline recovery checkpoint (2026-09-13): one authorized pnpm 9.15.4 attempt
selected root plus `paperclipai...` (18/32 projects), using offline mode,
ignore-scripts, ignore-pnpmfile, concurrency 1, and hardlink import. A windowless
supervisor enforced a 180-second ceiling, RAM <=80 percent, and S free >=8 GiB.
It exited 1 after 5.027 seconds with `ERR_PNPM_NO_OFFLINE_META`:
`Failed to resolve hono@>=4.11.4 <5.0.0-0` while resolving dependencies of
`@modelcontextprotocol/sdk@1.29.0` in the claude-local adapter closure.
Observed peak RAM 71.0644 percent; minimum S free 10.8630 GiB. Downloaded 0,
added 0. Worktree root node_modules and CLI tsx were still absent. Working and staged
lockfile blobs both remained `b8265b395be328934b4cdba5d4c527fa8fa5df90`, so no
restoration was needed. No fallback, network fetch, lifecycle build, canonical
dependency junction, commit retry, or push occurred.
Evidence in sibling `../paperclip-pr117-publication-logs/`: `offline-install.log`,
`offline-result.json`, `offline-resources.log`, and the bounded launcher
`offline-install.ps1`. This was a recoverable prerequisite, not a new authorization gate.

### Dependency recovery and commit (2026-09-13)

The subsequent bounded registry-enabled run succeeded in 15.5623 seconds:
442 cached packages linked, zero package archives downloaded, S free 10.68 GiB.
Lifecycle scripts remained disabled. A normal commit retry reached test discovery
but failed because the plugin SDK had no generated entry point. The repository's
existing `node scripts/ensure-plugin-build-deps.mjs` then succeeded in 18.6827
seconds. No canonical dependency directory was shared or modified.

The next normal tracked pre-commit completed in 52.7352 seconds and created
`36182c123`. Workspace-link preflight, token checks, staged Gitleaks, and related
suite discovery passed; discovery found no related Vitest suites. The separately
run nine Node tests remain the focused test evidence. React Doctor returned its
documented disabled/incomplete receipt (exit 2), not a passing audit.

Evidence under the sibling publication-log directory: `registry-result.json`,
`registry-install.log`, `build-20260912T212008Z.log`, and
`commit-20260912T212033Z.log`. Generated installation-only lockfile changes are
excluded from publication; the committed lockfile remains the base blob.
Push and hosted checks remain separate gates; no merge approval is implied.

Full-workspace provisioning then succeeded in 27.7419 seconds (724 cached
packages added, zero downloads). The normal pre-push full TypeScript gate passed
in 198.3 seconds. Its exact-test-plan gate correctly rejected the attempt because
the parent edited these documentation checkpoints while the hook ran. This was
an agent sequencing error, not a code or dependency failure. Commit the docs,
verify a pristine worktree/index, and leave them unchanged for the entire retry.
Evidence: `push-20260912T212352Z.log` (exit 1, 213.1086 seconds).

The pristine retry passed typechecking again (168.1s), then correctly rejected
missing advertised dev ancestry (`9f4a7e0aa`); receipt
`push-20260912T212812Z.log` (exit 1, 183.3623s). That dev commit changes only
OPEN_TASKS.md. It is merged without rewriting history, retaining its historical
unelevated proof and elevated-acceptance caveat in the consolidated issue entry.

An independent second agent reviewed exact head
`6ce1b282d247fbd2fb88ddc71b2bf5ae366fcbbd` against the original PR head and
approved the narrow correction for publication with no blocking code findings.
The reviewer explicitly retained every merge hold and noted that mock extraction
does not establish surrounding module or cleanup integration.

The dependency label is absent and must not be added by this correction.
The parent reports branch-protection API 404; the user's all-green condition
still governs. Required follow-up: trusted dependency review, all-green CI,
independent review of the amended head, and elevated Windows startup/shutdown
acceptance. `initialise()` still starts initdb directly; restricted-token data
directory access remains unverified. `windowsHide` on these two spawns is not
proof that all descendants remain windowless.

## Sources

The parent verified these sources; they support the design, not native acceptance:

- [Node child-process error event](https://nodejs.org/api/child_process.html#event-error):
  launch errors are separate from exit events.
- [PostgreSQL pg_ctl](https://www.postgresql.org/docs/current/app-pg-ctl.html):
  startup/shutdown and forwarding server options.
- [embedded-postgres upstream issue 38](https://github.com/leinelissen/embedded-postgres/issues/38):
  graceful shutdown concern.
- [PostgreSQL 18 pg_ctl source](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/bin/pg_ctl/pg_ctl.c):
  parent-verified `start_postmaster` ComSpec /C construction, lines 517-522.

## Maintainability

The vendor patch targets generated dist code, but the lifecycle additions are
human-authored and reviewed as such. This correction adds one net patch line
and preserves the existing lifecycle structure. The long start block remains
cohesive vendor lifecycle code; broad extraction is outside this bounded fix.
The new test file owns only mocked lifecycle verification. Shared setup is in
one harness; no copied lifecycle implementation or package dependency is added.
Complexity is assessed by a decision/nesting proxy, not a computed metric:
the harness has one platform selector and one spawn-outcome branch; its deepest
callback/control nesting is three. The generator helper has a loop and try/catch.
No new production helper or governance mechanism is introduced.

Source-line counts (nonblank, including comments): vendor patch 208 -> 209;
new test 0 -> 123. The patch is a generated-code diff, the lockfile is generated
data, and the workflow/ledger are declarative configuration. The new harness
spans 49 physical lines; it is the largest new function and stays below the
80-line review band. The pre-existing start insertion grows from 90 to 91 lines;
the correction retains that cohesive vendor block rather than extracting a new
runtime abstraction. The parent independently inspected the narrow patch and VM
tests and approved the correction for publication. MERGE HOLD remains.
