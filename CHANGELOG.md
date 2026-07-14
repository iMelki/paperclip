# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

- Declared scanning-only secret handling in `.git-toolkit.json` and removed six
  inert `filter=secrets` attributes; the policy-aware repo-health audit now
  reports zero warnings while pinned/fail-closed Gitleaks remains tracked in
  issue #13.
- Changed new UI-created Claude and OpenCode agents to require explicit opt-in
  before bypassing permission prompts, while preserving legacy omitted-config
  compatibility and the explicit unattended onboarding path.
- Added a PowerShell pre-commit checker for Windows and made Husky prefer it
  when `pwsh` is available, preserving the existing shell checker as the
  fallback path.
- Confirmed the modernization wave-3 governance baseline is present with a
  clean repo-health grade apart from accepted local secrets-store warnings.
- Backfilled the governance baseline with secrets-filter coverage, `.env`
  hygiene, and issue templates required by the modernization audit.
