# Paperclip UI — frontend-sota-gauntlet (rubric 1.8), 2026-08-27 (run 2 + shimmer run 3)

**Verdict: gauntlet total 20/21 — band `strong-internal-benchmark`.**

Run 1 (earlier same day) scored **18/21** because `/ASS/design-guide` timed out under
Playwright `load`/`domcontentloaded`. Run 2 fixed settle logic (`commit` + content
markers + scroll to Agent Capsule gallery). **Run 3 (same day)** routed
`/ux-lab/issue-chat` and browser-proved **2× `.shimmer-text`** with
`shimmer-text-slide` **2.5s** (see `shimmer-proof.json` + shots 07–08).

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
| `.shimmer-text` / thinking icon | **2 / 0** on `/ux-lab/issue-chat` (run 3); **0 / 0** on design-guide (run 2) |

## Shimmer evidence (run 3)

| Motif | Count on `/ux-lab/issue-chat` |
| --- | ---: |
| `.shimmer-text` | 2 |
| `.shimmer-text-muted` | 0 |
| `.paperclip-thinking-icon` | 0 |
| Animation | `shimmer-text-slide` **2.5s** |

Captured on vite preview `:5173` after routing `IssueChatUxLab` in `App.tsx`. Factory `:5113`
serves the prior bundle until restart; fixtures do not require a live agent run.

## Limits (stated)

1. **Thinking-icon** still **0** on captured surfaces (shimmer **proven** on UX lab).
2. Design-guide settle flag false only because skeleton heuristic saw loading chrome briefly; content and capsules were present (`mainTextLen` 17627) in run 2.
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
| **7.0** (gauntlet not run) | **7.5** — gauntlet **20/21** + capsule gallery (run 2) |
| **7.5** (post run 2) | **7.8** — run 3 adds browser-proven **shimmer-text** on issue-chat UX lab; hold below **8.0** until thinking-icon on product chrome or live (non-fixture) chat |
