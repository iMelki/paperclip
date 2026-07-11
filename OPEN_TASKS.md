# Paperclip Open Tasks

Last updated: 2026-07-11

This file is the durable local index for active `paperclip` issues.

## Active Issues

- [#11 - Default new UI-created agents to permission prompts enabled](https://github.com/iMelki/paperclip/issues/11)
  - Goal: require explicit opt-in before new UI-created Claude or OpenCode agents bypass permission prompts, while preserving legacy omitted-config and explicit unattended onboarding behavior.

- [#10 - Add native Antigravity adapter and retire legacy gemini_local path](https://github.com/iMelki/paperclip/issues/10)
  - Goal: replace the legacy Gemini CLI adapter with a native Antigravity (`agy`) adapter once its command/session behavior is mapped and tested.

- [#5 - Use relevant skills for market research, competitor analysis, and monetization planning](https://github.com/iMelki/paperclip/issues/5)
  - Goal: map competitors, ICPs, monetization options, and positioning for paperclip.

- [#6 - Design and build a landing page](https://github.com/iMelki/paperclip/issues/6)
  - Goal: define and implement a landing page with clear audience, value proposition, proof, and CTA.

## Recently Completed

- [#9 - Fix Windows pre-commit sandbox and plugin typecheck failures](https://github.com/iMelki/paperclip/issues/9)
  - 2026-06-23: added a Windows-native PowerShell pre-commit checker, made
    Husky prefer it when `pwsh` is available, verified the clean staged-files
    smoke passes, and verified plugin build dependency prep passes.
- [#7 - Backfill secrets hygiene and governance baseline after modernization audit wave 3](https://github.com/iMelki/paperclip/issues/7)
  - 2026-06-23: confirmed the wave-3 governance baseline is present and
    `Invoke-RepoHealthAudit.ps1 -Json` reports `grade=OK`, `fail=0`; only the
    accepted local secrets-store warnings remain.
- [#3 - Review and split preserved remote execution and continuation WIP](https://github.com/iMelki/paperclip/issues/3)
  - Closed after the preserved remote-execution and continuation work was
    reviewed and split out of the active task lane.
- [#1 - Adopt projects-ops repo bootstrap governance baseline](https://github.com/iMelki/paperclip/issues/1)
  - Completed via [PR #2](https://github.com/iMelki/paperclip/pull/2) on 2026-05-10.

## Supporting Docs

- [AGENTS.md](AGENTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [.github/labels.yml](.github/labels.yml)
