# Historical Gitleaks inventory — 2026-08-02

## Scope and method

The Paperclip `dev` history was scanned with Gitleaks 8.30.1 using the same
`git --all --redact --exit-code 2` mode used by CI. The scan covered 7,054
commits and reported 57 findings (20 were previously known; upstream
assimilation exposed additional historical fixtures). Findings were reviewed
by commit, file, detector, and source content. No value was copied into this
document.

## Classification

| Class | Findings | Evidence | Action |
| --- | ---: | --- | --- |
| Synthetic unit/integration fixtures | 38 | Test files use values such as `gateway-token-1234567890`, `test-secret`, redaction sentinels, UUID-like IDs, or deliberately fake PEM bodies. | Keep exact fingerprint ignores; new values and locations remain detectable. |
| Synthetic plugin/private-key validation fixtures | 11 | exe.dev and Google Sheets tests exercise PEM parsing with `pretend`/empty marker data; production parser messages contain marker examples only. | Keep exact fingerprint ignores; no key material is present. |
| Documentation/log examples | 5 | Deployment docs and parity logs explicitly describe revoked/example IDs or redacted placeholders. | Keep exact fingerprint ignores; do not treat as credentials. |
| Redacted smoke-test command examples | 3 | Hermes smoke script uses environment variables and literal placeholder auth examples; runtime output is redacted. | Keep exact fingerprint ignores; runtime secrets remain environment-owned. |

The 57 findings are therefore reviewed synthetic/history-only matches, not
confirmed active credentials. No rotation or revocation action is warranted
from this evidence. If a future scan exposes a non-placeholder value or an
active provider reference, the finding must be removed from the ignore list,
rotated/revoked, and tracked separately before merge.

## Guardrails

- `.gitleaksignore` contains exact commit/file/rule/line fingerprints only;
  there are no path-wide, rule-wide, or detector-wide suppressions.
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

The scan report used for this review was generated locally and is intentionally
not committed because it contains detector metadata and commit references that
are already represented by the exact ignore entries.
