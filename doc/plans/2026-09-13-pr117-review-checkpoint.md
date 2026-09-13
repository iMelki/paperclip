# PR117 independent review checkpoint

## Current state

The published head `4f2abb969bfe8bb12699fe2bf7fc190d7630e8f1` passed hosted
build, typecheck, tests and e2e. The trusted dependency-review check remains red.
No approval label, PR merge or branch deletion occurred. A new bounded guard
restricts Windows startup inputs; see the [proof receipt](../evidence/pr117/guard-review.md).
Native acceptance and failed-start cleanup remain unresolved, so publication
is not merge approval. Historical correction notes retain their original counts.

## Native CMD diagnostic boundary

At UTC 2026-09-12T21:42:11.9924817Z, a windowless bounded CMD subprocess used
an inert Node argument recorder instead of PostgreSQL. Four cases each exited
0 in 222-243 ms, with admission RAM 67.38% (ceiling 80%). Ordinary arguments
survived; a space-bearing value split; a synthetic percent-variable expanded;
an ampersand executed only a harmless echo marker. This is diagnostic evidence
of CMD interpretation, not native pg_ctl, elevated token or window-observer proof.
No live database, service, scheduler or production environment was modified.

Local retained reproducibility artifacts:

- `.tmp/paperclip-native-proof-20260913/Test-CmdForwarding.ps1`
- `.tmp/paperclip-native-proof-20260913/capture-argv.mjs`
- `.tmp/paperclip-native-proof-20260913/cmd-forwarding.json`

[Exact PostgreSQL 18.1 source](https://raw.githubusercontent.com/postgres/postgres/REL_18_1/src/bin/pg_ctl/pg_ctl.c)
routes startup through COMSPEC /C. The guard does not invent a quoting scheme:
it accepts only integer ports, no custom Windows flags, and constrained absolute
drive paths, and derives COMSPEC from validated SystemRoot. POSIX is unchanged.

## Unresolved lifecycle finding

The independent reviewer found that startup rejection can precede a late-starting
server. Paperclip marks successfully started instances only after resolution;
exit hooks cannot be relied on to reconcile failed startup before process exit.
Stopping by directory rereads a PID file and can target a different cluster.
PID/path/port checks alone do not establish ownership of this launch attempt.

Required repair: launch-bound process ownership, serialized start/stop, bounded
reconciliation, and retained original plus cleanup errors. Unknown identity must
remain unresolved: no foreign stop, data deletion or retry. Tests must cover
late readiness, replaced PID files, cleanup failure and setup failure after start.
No lifecycle patch or native launch was attempted in this guard-only change.

## Tracking and ownership

- [Issue35 verified checkpoint](https://github.com/iMelki/paperclip/issues/35#issuecomment-5648926233)
  records the two review holds; fleet owner retains shared-dev integration.
- [Issue118](https://github.com/iMelki/paperclip/issues/118) tracks inherited
  PostgreSQL18.1 applicability to public CVE-2026-16239 separately. Official
  advisory verified; no exploit, exposure or backport proof, no upgrade here.
- Existing issue33 owns fixture cleanup; review found reclamation may proceed
  after failed stop. Preserve data until independently confirmed termination.
- Canonical shared-asset promotion requested from the active agent-settings
  owner to avoid concurrent edits: dependency prerequisites are recoverable;
  do not share mutable node_modules links across worktrees; keep hook runs
  pristine and include current dev ancestry before expensive publication.

Independent second-agent review approved the exact guard hash in its receipt
for publication only; parent rerun: 15 pass, zero skips, 113.6 ms, clean diff.
The reviewer accepted the restricted contract and its compatibility boundary;
it does not authenticate SystemRoot or prove full package/POSIX startup.
Maintainability decision: keep the small validator within the single vendor
startup hunk rather than add a dependency-private cross-file helper. Existing
oversized lifecycle remains a documented extraction/ownership repair concern;
this bounded addition does not establish full-method maintainability acceptance.

Next: publish the bounded guard using normal hooks;
keep PR117 on hold until lifecycle/native/current-head review and checks pass.
