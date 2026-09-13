# PR117 Windows start guard receipt

Scope: owned correction worktree, starting HEAD 4f2abb969bfe8bb12699fe2bf7fc190d7630e8f1.
Only the vendor patch, focused harness, ledger, and new guard receipts changed.
No install, commit, push, GitHub, elevation, database or service operation ran.

## Contract

- Numeric integer ports 1..65535 only; no coercion.
- Windows postgresFlags must be an empty array. Errors explain unsupported
  custom flags without including raw values.
- databaseDir, resolved postgres/pg_ctl, SystemRoot, derived log and CMD paths
  must be absolute drive paths without ASCII controls, quotes, expansion or
  shell-sensitive characters. Ordinary spaces remain accepted. Relative, UNC,
  device, wildcard and alternate-stream path forms fail closed.
- COMSPEC is derived from validated SystemRoot/System32/cmd.exe. All inherited
  case variants are removed from a copied environment before setting COMSPEC.
- Validation precedes executable preparation, filesystem access and spawn in
  the Windows block. The validated postgres path is explicitly passed as pg_ctl
  -p; the port alone goes through -o. No CMD escaping was introduced.
- POSIX falls through to its existing executable preparation and startup;
  custom flags remain untouched there. Stop and failure cleanup are unchanged.

## Proof

Exact caller: `C:/nvm4w/nodejs/node.exe --test --test-isolation=none scripts/embedded-postgres-pgctl.test.mjs`.
Runtime: Node v24.18.0. The existing policy job uses Node 24 and these test flags.

Private-worktree mutation bypassed the port check, flags check, unsafe-character
regex and COMSPEC deletion. Readback confirmed all four changes before running.
The result was exactly four attributable failures: three missing expected
rejections and retained mixed-case COMSPEC keys. Eleven other tests passed.
Raw output and exit 1: [guard-negative.log](guard-negative.log).

Restored raw SHA256 matched the pre-mutation patch:
`38956adc68dc390d096cb27ace051bc3a6bdf053834eb01c97f9d1ee82e5c19d`.
Same caller: 15 passed, zero failed/skipped, exit 0, 122.725 ms.
Raw output: [guard-restored.log](guard-restored.log). Ledger entry:
`embedded-postgres-windows-start-input-guard`.

`node --check scripts/embedded-postgres-pgctl.test.mjs`, patch hunk parsing via
`git apply --numstat patches/embedded-postgres@18.1.0-beta.16.patch`, ledger JSON
parse, and `git diff --check` passed. Numstat: 165 additions, 23 deletions to
vendor dist/index.js. This is hunk syntax proof, not package application proof.

## Maintainability and limits

Harness: 130 -> 203 physical lines; 122 -> 188 nonblank, non-comment source
lines. Largest named function remains harness: 49 -> 50 physical lines.
New path validator: 8 lines, one conditional; compound predicates deliberately
share one error contract. New rejection helper: 6 lines. Path cases share one
matrix and one side-effect assertion helper rather than duplicate checks.
Changed test nesting proxy: two loops and one if/else chain (three levels);
no complexity analyzer was installed or run.

Patch artifact: 209 -> 234 lines, classified as a vendor diff, not a complete
production file. Existing start lifecycle hunk grows 97 -> 121 output lines;
this remains one vendor-method change with an 8-line local validator. Complete
vendor function/file metrics are unavailable without source reconstruction;
the parent must review the existing oversized lifecycle scope. No independent
maintainability exception or full-module acceptance is claimed here.

The VM mocks spawn/filesystem/platform. It proves the restricted input contract
and ordering within the extracted block, not universal Windows path safety,
native CMD behavior, elevated/restricted token startup, descendant windows,
package integration, or failure cleanup. Full repo build/typecheck/tests were
not run for this bounded no-install mitigation. Parent review remains next.
