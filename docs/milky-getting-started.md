# Paperclip — Getting Started Guide for Ilan Melki

**Date:** 2026-05-04  
**Repo:** `tools/paperclip/` (upstream: `paperclipai/paperclip`, local: `iMelki/paperclip`)  
**Local master:** up to date with `upstream/master` as of 2026-05-04  
**Status:** Read-only architecture review + adoption guidance. Running locally not required before reading this guide.

---

## What is Paperclip (The One-Line Version)

> **If OpenClaw is an _employee_, Paperclip is the _company_.**

Paperclip is the **control plane for a company of AI agents**. You define companies, goals, org charts, and budgets. Agents run externally (via adapters) and phone home with heartbeats. You are the board operator — you set strategy and approve direction; agents execute.

---

## How It Fits Your Stack

| Layer | Tool | Role |
|-------|------|------|
| **Agent runtime** | OpenClaw (claw-dev, Samantha, Asimtop Claw) | Executes agent prompts, calls tools, manages context |
| **Agent adapters** | Claude Local, Codex Local, Hermes Local, OpenClaw Gateway | Bridges Paperclip → agent runtimes |
| **Control plane** | **Paperclip** | Org chart, goals, task hierarchy, budgets, heartbeats |
| **Memory** | MemSys router → MemPalace / Meilisearch / qmd | Gives agents recall across sessions |
| **Approvals / guardrails** | Mission Control / policy-gateway | Human-in-the-loop for destructive ops |

Paperclip does not replace Mission Control or OpenClaw. It sits _above_ them as the strategic layer.

---

## Running Paperclip Locally

### Quickstart (no clone needed)

```powershell
npx paperclipai onboard --yes
# Follow the prompts. Starts the server at http://localhost:3100
```

To restart later:

```powershell
npx paperclipai run
```

### From the local clone (already in `tools/paperclip/`)

Prerequisites: Node.js 20+, pnpm 9+

```powershell
cd S:\source\CCAI\Assistants\tools\paperclip
pnpm install
pnpm dev
# Server at http://localhost:3100 (API) and http://localhost:3101 (UI)
```

> **Note:** The local repo uses an embedded PostgreSQL by default — no external database required.

---

## Core Concepts Cheatsheet

| Concept | What it Is | Your Action |
|---------|-----------|-------------|
| **Company** | Top-level unit. Has a goal, org, budget. | Create one per major project domain. |
| **Goal** | The north star a company exists to achieve. | Set one concrete, measurable goal per company. |
| **Agent** | An AI employee. Has adapter, role, budget, instructions. | Create agents with clear role descriptions. |
| **Adapter** | How an agent runs (Claude, Codex, Hermes, OpenClaw, HTTP). | Pick based on what runtime the agent uses. |
| **Org chart** | Who reports to whom. Strict tree: CEO at root. | Build top-down: CEO → VPs → ICs. |
| **Issues** | Unit of work. Has parent, status, assignee. Traces to company goal. | Let agents create sub-issues; you create epics. |
| **Project** | Groups issues toward a deliverable. | One project per major initiative. |
| **Heartbeat** | Agent's scheduled wake-up cycle. | Set intervals; agents act on each heartbeat. |
| **Budget** | Monthly token spend limit. Soft alert at 80%, hard stop at 100%. | Set company-level and per-agent limits. |

---

## Connecting to GitHub Projects / Issues

Paperclip's model is **Paperclip-native** task tracking, not a GitHub sync. However:

### Option A: Issue references in agent instructions

Give agents explicit permission and access to call `gh` CLI. Include in the agent's system prompt:

```
When you complete a task, close the corresponding GitHub issue at
iMelki/<repo>#<issue-number> with a summary of what you did.
```

Agents with a `process` or `claude_local` adapter can run `gh issue close ...` directly.

### Option B: HTTP webhook adapter → GitHub Actions

Use the `http` adapter type to send a webhook to a GitHub Actions workflow that creates/updates issues on task state changes. Useful for two-way sync at scale.

### Option C: Manual linking via agent instructions + MemSys

Agents can use MemSys recall to look up existing GitHub issues before creating duplicates. The MemSys skill gives any agent access to `memory.query`, which searches MemPalace for relevant past context including issue history.

### Option D: Export/import via COMPANY.md (for version control)

Export your Paperclip companies to markdown packages that live in GitHub repos:

```sh
paperclipai company export <id> --out ./companies/asimtop --include company,agents,projects,skills
```

Check the output into a GitHub repo. Changes are tracked as commits. Agents can commit updated `AGENT.md` files directly.

---

## Company Umbrellas to Define

Based on your active projects across all workspace roots and Obsidian notes, here are the recommended company definitions:

---

### Company 1: Asimtop AI Platform

**Goal:** _Build and operate the Asimtop AI-powered assistant platform to production quality, serving paying users._

**Repos:** `claw`, `mission-control`, `mission-control-kanban`, `mempalace-service`, `policy-gateway`  
**Key agents:**
- CEO — strategy, delegation, issue triage
- CTO — technical architecture decisions
- Backend engineer — Railway services, API work (`claw/`, `policy-gateway`)
- DevOps engineer — Railway deployments, secrets, monitoring
- QA engineer — test coverage, Pester tests, CI checks

**Project structure:**
- `Platform Core` — OpenClaw + Mission Control stability
- `Memory System` — MemSys router + MemPalace + Meilisearch
- `Agent Tooling` — agent-settings, skills, workflows

---

### Company 2: MemSys (Memory Infrastructure)

**Goal:** _Build the most capable, always-on memory system for AI agents, enabling sub-second recall across 1M+ knowledge items._

**Repos:** `memsys`, `mempalace-service`, `qmd-service` (search_api), `agent-settings` (shared/skills/memsys-*)  
**Key agents:**
- CEO — product decisions, integration prioritization
- Data engineer — mining scripts, index pipelines, MemPalace sync
- Backend engineer — router adapters, new backends, API endpoints
- Researcher — evaluates new memory backends (Hindsight, Honcho, code search)

**Project structure:**
- `Backend Adapters` — MemPalace MCP, Meilisearch, qmd
- `Data Pipelines` — Mine-Knowledge, Mine-All, agent conversation miners
- `Router & API` — memsys-router service, query routing
- `Evaluation` — gold-set tests, adapter benchmarks

---

### Company 3: TradingCortex

**Goal:** _Automate trading signal generation and position management for a live portfolio targeting consistent alpha._

**Repos:** `TradingCortex`, `strategy-service`, `analytics-service`, `tradestation-service`, `persistence-service`, `webhook-service`, `community-automation-service`, `entitlements-service`  
**Key agents:**
- CEO — trading strategy decisions, risk appetite
- Quant engineer — strategy logic, backtesting
- Backend engineer — broker API integrations (TradeStation)
- Analyst — market data pipelines, performance reporting

**Project structure:**
- `Signal Engine` — strategy-service, analytics
- `Broker Integration` — tradestation-service, webhook-service
- `Community & Alerts` — community-automation-service, Hermes notifications

---

### Company 4: Developer Tools & Open Source

**Goal:** _Build and maintain a suite of open-source developer tools and services used by the broader developer community._

**Repos:** `hermes`, `voice-transcription-service`, `kokoro-secure`, `git-toolkit`, `job-pipeline-os`, `nestjs-template`, `content-factory`  
**Key agents:**
- CEO — OSS roadmap, community feedback
- Backend engineer — services and API work
- DevOps engineer — Railway deployments, Docker configs

**Project structure:**
- `Hermes Gateway` — Telegram AI gateway
- `Voice Tools` — voice-transcription-service, kokoro-secure
- `Templates & Scaffolds` — nestjs-template, git-toolkit

---

### Company 5: Personal Website & Portfolio

**Goal:** _Launch and maintain a polished personal website showcasing projects, skills, and contact for professional opportunities._

**Repos:** `landing-page-v2`, `personal-website`, `portfolio-2411`, `landing-page`  
**Key agents:**
- CEO / Creative Director — copy, design direction
- Frontend engineer — React/Next.js implementation
- SEO/Content — blog posts, project descriptions

---

## Connecting Obsidian to Paperclip

Paperclip exports companies to markdown (`COMPANY.md`, `AGENT.md`, etc.). These live well in Obsidian:

1. Export each company to `C:\Obsidian\Vaults\Personal\001 Projects\Companies\<name>/`
2. Link from the corresponding Obsidian project note (e.g. `001 Projects/Projects/OpenClaw.md`) via Obsidian wiki link.
3. Agents can write status updates into `HEARTBEAT.md` files inside the company folder — these become Obsidian-native notes.
4. The `companies-spec` supports a `SOUL.md` file for the company's values and principles — great for the Obsidian vault.

**Two-way sync strategy:**
- **Paperclip → Obsidian:** `paperclipai company export` to the vault on demand or via a scheduled task.
- **Obsidian → Paperclip:** `paperclipai company import` from the vault path after editing `AGENT.md` files manually.
- Use `git commit + push` on the vault (Obsidian git plugin) to version-control all changes.

---

## Adapter Recommendations Per Agent Type

| Agent role | Recommended adapter | Why |
|-----------|--------------------|----|
| Strategic (CEO, CTO) | `claude_local` | Best at reasoning, strategy, delegation |
| Coding | `codex_local` or `claude_local` | Good at code generation, PR-level tasks |
| DevOps / infrastructure | `process` or `claude_local` | Needs shell access; can run `railway`, `gh`, `pwsh` |
| Research / analysis | `claude_local` or `http` | Long-context reading; can call search APIs |
| Telegram/comms | `hermes_local` | Direct integration with your Hermes gateway |
| OpenClaw coordination | `openclaw_gateway` | Routes to your existing hosted OC instances |

---

## First Steps (Concrete Sequence)

```
1. npx paperclipai onboard --yes
   → http://localhost:3100 opens

2. Create company: "Asimtop AI Platform"
   Goal: "Ship a stable, production-quality AI assistant platform by 2026-Q3"

3. Create CEO agent
   Adapter: claude_local
   Budget: $10/month
   Instructions: <see below>

4. Create project: "Memory System"
   Goal association: company goal

5. Import existing skills from agent-settings:
   paperclipai company import --from S:\source\CCAI\Assistants\agent-settings\shared\sub-agents

6. Set company budget: $100/month total
   Agent budgets: CEO $10, CTO $20, engineers $15 each

7. Enable CEO heartbeat: every 4 hours
   Let CEO create the initial strategy and sub-tasks

8. Export to Obsidian:
   paperclipai company export <id> --out "C:\Obsidian\Vaults\Personal\001 Projects\Companies\asimtop"
```

### CEO Agent Starter Prompt (Asimtop)

```
You are the CEO of Asimtop AI Platform. Your company's goal is:
"Ship a stable, production-quality AI assistant platform by 2026-Q3"

On each heartbeat:
1. Review the current task board. Identify any blocked, stale, or urgent issues.
2. Check the MemSys router for recent decisions (use the memsys-status skill to query memory).
3. Create or update sub-tasks for the CTO and engineering agents.
4. Write a brief status update in HEARTBEAT.md.
5. If any critical issues are open on GitHub (iMelki/claw, iMelki/memsys), reference them in your task tree.

Tools available: gh CLI, railway CLI, memsys query, paperclipai CLI.
Budget: $10/month. Prioritize strategic clarity over implementation details.
```

---

## Notes on Our Local vs Hosted Setup

| Concern | Current answer |
|---------|---------------|
| Where does Paperclip run? | Locally via `npx paperclipai run` for now. No Railway deployment yet. |
| Where do agents execute? | Via adapters on the same machine (Claude CLI, Codex CLI, etc.) |
| Is there a hosted Paperclip? | Not yet — this is a local-first control plane today. Railway deploy is future work. |
| Can multiple OC instances connect? | Yes — use `openclaw_gateway` adapter pointing at `claw.tail979b1a.ts.net` or `asimtop.tail979b1a.ts.net` |
| Does Paperclip replace Mission Control? | No. Mission Control is the OC-specific UI. Paperclip is the org/goal/budget layer above it. |

---

## Related Docs

- [Paperclip official docs](https://paperclip.ing/docs)
- [Core concepts](../tools/paperclip/docs/start/core-concepts.md)
- [Creating a company](../tools/paperclip/docs/guides/board-operator/creating-a-company.md)
- [Adapters overview](../tools/paperclip/docs/adapters/overview.md)
- [Companies spec](../tools/paperclip/docs/companies/companies-spec.md)
- [Architecture plan (inbox)](../tools/mission-control/inbox/paperclip-architecture-plan.md)
- [AGENT_REGISTRY.md](../AGENT_REGISTRY.md) — all active runtimes and surfaces
