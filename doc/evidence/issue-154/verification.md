# Workspace containment completion proof — issue #154

The base is `cf181ecd2852dadedbe3d3747175e380cd75ae27` from a fresh `origin/dev` fetch.
The fixed test file SHA-256 is `95d37d85c1d1ed93774e7383e6b8f6cbe0f17b94d80f0495cecbde040352c1e8`.
Native Windows runs used the real disposable embedded PostgreSQL and Git worktrees.
The process runner retained individual raw logs and JSON reports privately.
The public [run receipts](runs.json) omit host paths and personal identifiers.

## Cause and change

`executeRun` records a terminal run before issue release, recovery work,
`finalizeAgentStatus`, and its `finally` block finish. Polling the terminal row
is not a completion barrier. The idle assertion then had only the default
one-second `vi.waitFor` budget. Reconciliation also read state after a terminal
row rather than full execution completion. These tests now await the existing
`drainActiveRunExecutions` promise barrier before reading durable state.
The old 10-second row/effect polls and one-second status wait are removed.
The existing 15/30-second test budgets and teardown drain are unchanged.
Git fixture children use `windowsHide: true`.

## Negative proof

All five unchanged baseline runs passed; natural failure was not reproduced.
To make the known finalization window observable, a trigger in the disposable
test database delays only the two marked agents' running-to-idle update by
1.5 seconds. This exercises a real slow database write rather than adding CPU
pressure or replacing service behavior. The trigger and marker remain in the
committed suite as regression coverage.

Restoring the old polling helpers and status wait, while keeping that fixture,
gave one failure and seven passes, exit 1. The project-primary case read
`running` instead of `idle`: see [negative output](negative.txt).
The git-worktree variant passed in this run; scheduling can consume part of
the injected window before polling starts. This is not a claim that every old
case fails on every host. The failure was an assertion on saved agent status,
not a setup, import, timeout of the whole test, or teardown error.

Restoration used the saved fixed bytes and verified their SHA-256. The next ten
processes ran those same bytes and all passed eight tests with no skips.
No shared-state, overlapping-running-run, or Windows teardown failure was
observed in these runs. This does not prove those defects impossible elsewhere.

## Commands and results

Each run executed:

```sh
cd server
node ../node_modules/vitest/vitest.mjs run src/__tests__/heartbeat-workspace-branch-containment.test.ts --reporter=default --reporter=json --outputFile.json=<run-report>
```

| Run | Passed | Failed | Skipped | Exit | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline-01 | 8 | 0 | 0 | 0 | 68.313 |
| baseline-02 | 8 | 0 | 0 | 0 | 87.032 |
| baseline-03 | 8 | 0 | 0 | 0 | 83.047 |
| baseline-04 | 8 | 0 | 0 | 0 | 88.0 |
| baseline-05 | 8 | 0 | 0 | 0 | 95.39 |
| negative-old-waits-01 | 7 | 1 | 0 | 1 | 86.937 |
| fixed-01 | 8 | 0 | 0 | 0 | 70.234 |
| fixed-02 | 8 | 0 | 0 | 0 | 85.703 |
| fixed-03 | 8 | 0 | 0 | 0 | 78.203 |
| fixed-04 | 8 | 0 | 0 | 0 | 81.281 |
| fixed-05 | 8 | 0 | 0 | 0 | 75.625 |
| fixed-06 | 8 | 0 | 0 | 0 | 89.109 |
| fixed-07 | 8 | 0 | 0 | 0 | 95.375 |
| fixed-08 | 8 | 0 | 0 | 0 | 83.203 |
| fixed-09 | 8 | 0 | 0 | 0 | 56.313 |
| fixed-10 | 8 | 0 | 0 | 0 | 77.641 |

The ten fixed processes passed 80/80 test executions in total. Average host CPU
usage during those processes ranged from 37.4% to 72.5%; the
per-process RAM samples and UTC start times are in `runs.json`. The negative
process averaged 67.7% CPU.
Load was measured from Windows `GetSystemTimes` deltas, not inferred from
test duration. Baseline CPU deltas were not collected.

## Scope and remaining proof

This change affects one serialized integration suite and contributor guidance.
The existing drain is already used by 12 test/helper files. A bounded scan found
five other suites with terminal-row polling helpers; their behavior is outside
this issue's change and is not claimed fixed. Enclosing timeouts still detect
hung execution. Source/package typecheck and hook results are in the review
handoff. Hosted CI and independent co-CTO review are pending. No live instance
was updated and no PR or issue was written by this lane.
