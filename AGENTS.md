# Agent Instructions - Paperclip

Paperclip is an agentic content acquisition and processing engine.

## Operating Rules

- Treat GitHub issues as canonical task records and `OPEN_TASKS.md` as the local index.
- Follow the governance baseline in [CONTRIBUTING.md](CONTRIBUTING.md).
- Use branch names in the form `agent/{agent-name}/{issue-number}-{slug}`.
- Stay within the allowed file scope defined in the issue.
- Verify stability before PR.

## Technical Standards

- Language: Python / TypeScript
- Tooling: `ruff`, `eslint`.

## Safety Protocol

- Never commit private configuration or environment variables.
- Do not add memory sources without explicit approval.
