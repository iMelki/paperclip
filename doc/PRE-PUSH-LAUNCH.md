# Pre-push native launch contract

The normal hook preserves the policy checks, exact outgoing secret scans,
workspace preflight, forbidden-token check, full recursive typecheck and
deterministic exact tests. Transport failure rejects the push. It does not
authorize a reduced check, automatic retry, install, or process restart.

## Native transport

On the PowerShell path, Husky selects a native PowerShell executable and the
Node broker starts it with `-NoProfile -NonInteractive`, literal remote argv,
windowless creation and consumed pipes. Git ref updates are the only stdin
protocol: the broker reads at most 1MiB within 10 seconds, forwards those exact
bytes and closes the child's stdin. Missing or malformed updates still fail the
existing security gate. POSIX fallback selection remains unchanged.

`gate-native.ps1` invokes native commands through `ProcessStartInfo`, with
`UseShellExecute=false`, `CreateNoWindow=true`, explicit argv and closed stdin.
It drains stdout/stderr concurrently into separate durable stream logs and
the caller's output. Bootstrap capture is bounded at 128KiB; before a local log
is known, output goes to the supervisor's durable streams. The normal gate log
contains step status and elapsed time; sibling `.stdout.log`, `.stderr.log` and
`.bootstrap.*.log` files retain native output. Log write failure fails the gate.

`gate-child.mjs` gives Node callers the same closed-input and async pipe
contract. Both output queues must finish before a successful result. Spawn,
stream, sink, deadline and capture failures are distinct from a natural exit
status and cannot become success. Exact Vitest files remain sequential and
independent: a later unmatched or failed file rejects the whole plan.

The local child bound is 30 minutes with at most 15 seconds for direct-child
cleanup. These are additional bounds; they never restart or extend the
supervisor's whole-run deadline. These portable helpers do not create a Windows
Job Object, certify descendant cleanup, or prove absence of visible windows.
Windows unattended execution requires an already qualified scheduler/service/
supervisor/Job owner with durable capture, finite aggregate limits and final
zero-child proof. Do not infer Job membership from an environment marker.
The outer physical-memory, disk, capture and deadline guards remain independent.

## Exact installed pnpm selection

PowerShell reads the selected pnpm command as metadata and invokes exact native
Node with a qualified pnpm package's declared JavaScript bin. It does not execute
`pnpm.cmd`. The project `packageManager` must name an exact pnpm version.

The resolver considers the local installed package, the selected command's
adjacent package, the selected installer's exact-version tools slot, and
qualified ambient `npm_execpath` metadata. Every candidate must have package
name/version and a regular bin inside the package after lexical and realpath
checks. It never scans for a newest version, downloads, or runs a version-manager
handoff. `-PnpmCli` supplies an explicit installed CLI when discovery is
insufficient; an invalid explicit binding refuses instead of falling back.
The selected manifest and bin hashes are checked again before each pnpm step.
These hashes identify local files; name/version alone does not prove provenance.

Directly selecting the project version is intentional. Some pnpm wrapper
versions invoke another version with inherited stdio even when it is cached.
The full recursive typecheck adds `--stream`; serial workspace scheduling
without streaming can select inherited stdio again. All original workspaces and
compiler checks remain required.

## Qualification and remaining evidence

The added fixtures cover natural failures, output/backpressure, transport
failure, finite input/capture, wrong package versions, path escapes and delayed
exact-file failure. The PowerShell caller fixture uses real Node with inert gate
modules in its own Git root; it never runs the product's full typecheck. A second
fixture copies the real stable runner and uses an inert Vitest CLI to verify
sequential invocation and delayed failure. Simulated stream fixtures are not
native cleanup receipts.

For a new source candidate, run the focused Node suites first under the normal
fresh-resource admission, then retain the full normal hook's original checks.
Required gate-negative proof uses a disposable copy, for example removing an
exact-file `await` or an explicit launch option, and must cause named original
cases to fail before restoring exact bytes and passing. Never edit the reviewed
candidate for that control. Retain the exact diff and source hashes with results.

Installed pnpm lifecycle shells, Vitest workers, native fixture descendants and
Git/MSYS creation still require selected-chain review and actual owned-run
observation. A clean late window snapshot does not prove no launch flash. A
source test or merged PR does not prove the selected installation, served
revision, agent execution or useful delivery. Keep those acceptance receipts
separate. Work remains tracked on the existing PR169; no extra PR is needed.

## Direct local hook tasks

The PowerShell pre-commit and pre-push hooks use `run-workspace-gate.mjs` for
tokens, workspace-link preflight, unit tests and workspace typechecks. The
project-pinned pnpm CLI supplies authoritative workspace and dependent-filter
LIST results; it never starts lifecycle scripts in this route. Unknown scripts,
pre/post events, membership or qualified input drift reject the gate.

Every supported package retains its original compiler argv and working
directory. Compound scripts retain SDK build dependencies, shared emitting
build, the SSH source audit, both migration checks and the second workspace-diff
test configuration. Dependency-first serial execution bounds simultaneous work.
The current 31 packages expand to 44 steps, including 33 compiler invocations.

A scoped loader uses the installed TypeScript 5.9.3 API inside the Node process
to execute only the workspace preflight and two migration CLI files, plus two
migration data modules. It supports Node 20 without tsx/esbuild subprocesses,
retains each actual CLI entry and maps only the safety CLI's two data imports.
Transpilation only erases runtime types; all real compiler checks still run.
Private token queries preserve the existing policy core, literal Git argv,
tracked/private token sources and fail-closed exit-status behavior.

Caller fixtures validate routing/status with inert task modules. Real loader
fixtures exercise migration failures/restores and the original workspace-link
repair. They do not establish full real hook, descendant, installed or served
acceptance; those require the owner's separately recorded normal execution.
