# Historical Gitleaks inventory — 2026-08-02

## Scope and method

The Paperclip `dev` history was scanned with Gitleaks 8.30.1 using the same
`git --all --redact --exit-code 2` mode used by CI. The current scan on
2026-08-08 at `4565e1a86` covered 7,262 commits / 250.07 MB and completed with zero
unignored leaks. The inventory contains 64 reviewed findings: the previously
reviewed 57 plus seven exact matches discovered in the superseded
`49307b05dfcf345f71320ee4aefaf9db6f1d299a` test commit. Those seven values are
literal `REDACTED` skill-key placeholders. Findings were reviewed by commit,
file, detector, and source content. No value was copied into this document.

## Classification

| Class | Findings | Evidence | Action |
| --- | ---: | --- | --- |
| Synthetic unit/integration fixtures | 45 | Test files use values such as `gateway-token-1234567890`, `test-secret`, redaction sentinels, UUID-like IDs, deliberately fake PEM bodies, or literal `REDACTED` skill-key placeholders from the superseded skill-usage test. | Keep exact fingerprint ignores; new values and locations remain detectable. |
| Synthetic plugin/private-key validation fixtures | 11 | exe.dev and Google Sheets tests exercise PEM parsing with `pretend`/empty marker data; production parser messages contain marker examples only. | Keep exact fingerprint ignores; no key material is present. |
| Documentation/log examples | 5 | Deployment docs and parity logs explicitly describe revoked/example IDs or redacted placeholders. | Keep exact fingerprint ignores; do not treat as credentials. |
| Redacted smoke-test command examples | 3 | Hermes smoke script uses environment variables and literal placeholder auth examples; runtime output is redacted. | Keep exact fingerprint ignores; runtime secrets remain environment-owned. |

The 64 findings are therefore reviewed synthetic/history-only matches, not
confirmed active credentials. No rotation or revocation action is warranted
from this evidence. If a future scan exposes a non-placeholder value or an
active provider reference, the finding must be removed from the ignore list,
rotated/revoked, and tracked separately before merge.

## Guardrails

- `.gitleaksignore` contains exact commit/file/rule/line fingerprints only;
  there are no path-wide, rule-wide, or detector-wide suppressions.
- The seven `49307b05…` entries added on 2026-08-08 correspond only to the
  superseded test file and are not active credentials; the file is absent from
  the current tree.
- The CI scan remains fail-closed for new values, changed lines, new commits,
  and fingerprints not listed in the reviewed inventory.
- Re-run `node scripts/verify-gitleaks.mjs --history` after any upstream merge
  or fixture change and update this inventory with a fresh scan timestamp.
- This review does not authorize history rewriting or force-pushing shared
  branches.

## Reproduction

```powershell
node scripts/verify-gitleaks.mjs --history
```

The current scan report is retained as paired stdout/stderr artifacts at
`S:\source\CCAI\Assistants\_factory-work\paperclip-gitleaks-history-4565.stdout.log`
and `paperclip-gitleaks-history-4565.stderr.log`.
The prior 7,260-commit artifact is historical evidence only; it is intentionally
outside the repository because these logs contain detector
metadata and commit references that are represented by the exact ignore
entries.
