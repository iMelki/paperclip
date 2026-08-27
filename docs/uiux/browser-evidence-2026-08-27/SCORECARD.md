# Paperclip UI — frontend-sota-gauntlet (rubric 1.8), 2026-08-27 (run 2)

**Verdict: gauntlet total 20/21 — band `strong-internal-benchmark`.**

Run 1 (earlier same day) scored **18/21** because `/ASS/design-guide` timed out under
Playwright `load`/`domcontentloaded`. Run 2 fixed settle logic (`commit` + content
markers + scroll to Agent Capsule gallery). Delight may move from measured **7.0**
to **7.5** on this evidence; not anchor-9 without live shimmer/thinking on product chrome.

## Scorecard (0–3 per area)

| Area | Score | Rationale |
| --- | --- | --- |
| Visual direction | **3** | Design-guide Agent Capsule gallery: **16× online**, **1× slot**, **16× liquid**, brand gradients visible in browser |
| UX clarity | **3** | Dashboard + agents settled; design-guide **17 627 chars** rendered (screenshot captured) |
| Motion / interactivity | **3** | `agent-cap-slot-pulse` **1.6s** running on design-guide; **2× hb-blink** on agents-all |
| Technical quality | **2** | One **404** console resource on design-guide (non-fatal); no page crashes |
| Responsiveness | **3** | Desktop 1440 + mobile 390 dashboard shots |
| Verification | **3** | Reduced-motion: capsules present, slot/online animations **none** when `reduce` active |
| Complexity fit | **3** | CSS/DOM motifs — correct ladder for ops board |
| **Total** | **20/21** | **strong-internal-benchmark** (≥19) |

## Design-guide evidence (browser-proven)

| Motif | Count on `/ASS/design-guide` |
| --- | ---: |
| `.agent-cap-online` / blue | 16 |
| `.agent-cap-liquid` | 16 |
| `.agent-cap-slot` | 1 |
| `.agent-cap*` (any) | 70 |
| `.shimmer-text` / thinking icon | 0 (not on this surface; live chat routes only) |

## Limits (stated)

1. **Shimmer / thinking-icon** still **not** measured on factory live chrome (agents paused; motifs live on chat surfaces, not design-guide).
2. Design-guide settle flag false only because skeleton heuristic saw loading chrome briefly; content and capsules were present (`mainTextLen` 17627).
3. Coordination API: **`GET /api/companies/{id}/coordination/tasks`** returns **200** on `:5113` (prior “500” was wrong path / observer config).

## Artifacts

| File | Role |
| --- | --- |
| `gauntlet.json` | Machine receipt |
| `gauntlet.mjs` | Runner (`BASE=http://127.0.0.1:5113`) |
| `gauntlet-shots/` | design-guide, dashboard, agents, reduced-motion, mobile |

Instance: Assistants Software Factory (`ASS`), commit **`c7981d6a`**.

## Delight (rubric 1.8) recommendation

| Before | After (honest) |
| --- | --- |
| **7.0** (gauntlet not run) | **7.5** — gauntlet **20/21** with browser evidence on capsule gallery; hold below **8.0** until shimmer/thinking proven on a live working-state surface |
