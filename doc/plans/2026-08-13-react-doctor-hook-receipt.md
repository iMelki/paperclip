# React Doctor hook receipt boundary

## Decision

Paperclip's pre-commit hook is prepared to resolve an exact local
`react-doctor` development dependency, but the branch currently has no pinned
dependency. It never invokes `npx`, a package manager, a shell, a floating
version, or a network bootstrap. Until the dependency is separately pinned and
locked, the runner emits an `incomplete` receipt and exit code 2; the hook
reports that the quality gate is disabled and continues. A real analyzer
failure remains a blocking nonzero exit.

The child receives a minimized environment, a fixed repository work tree, and
cache/compile-cache writes disabled, a bounded 120-second runtime, and drained
stdout/stderr pipes. The hook emits one privacy-safe
`paperclip.react-doctor-receipt.v1` JSON receipt to stdout. The receipt binds
the package manifest and launcher bytes, scope, exit code, duration, output
digest, and mutation/network intent. Missing, malformed, terminated, or
version-drifted execution is incomplete and exits nonzero.

## Qualification boundary

This is a reproducibility and fail-closed hook repair. It is not analyzer
qualification. Full package closure, license/terms review, OS-level network
denial, and genuine Windows/Linux receipts remain separate Doctor Mesh gates.

## Validation

`node --test scripts/run-react-doctor.test.mjs` covers the no-floating-command
boundary, hook first-phase failure propagation, disabled/missing-package
receipt, and a positive fake local analyzer receipt. A later pin/lock change
must add the real analyzer receipt and license/closure evidence before this
hook can become an active quality gate.
