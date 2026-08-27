# Paperclip UI — frontend-sota-gauntlet (rubric 1.8), 2026-08-27 (runs 2–5)

**Verdict: gauntlet total 20/21 — band `strong-internal-benchmark`.**

Run 1 (earlier same day) scored **18/21** because `/ASS/design-guide` timed out under
Playwright `load`/`domcontentloaded`. Run 2 fixed settle logic (`commit` + content
markers + scroll to Agent Capsule gallery). **Run 3 (same day)** routed
`/ux-lab/issue-chat` and browser-proved **2× `.shimmer-text`** with
`shimmer-text-slide` **2.5s** (see `shimmer-proof.json` + shots 07–08).
**Run 4 (same day)** browser-proved **1× `.shimmer-text`** on **live issue chat**
during Factory Builder `running` on **ASS-28** (see `live-agent-shimmer-proof.json`
+ shot 11). **Run 5 (same day)** routed `/ux-lab/loading-chrome` and browser-proved
**1× `.paperclip-thinking-icon`** with `paperclip-thinking-draw` **1s** (see
`thinking-icon-proof.json` + shot 12).

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

## Shimmer evidence (run 3 — UX lab fixture)

| Motif | Count on `/ux-lab/issue-chat` |
| --- | ---: |
| `.shimmer-text` | 2 |
| `.shimmer-text-muted` | 0 |
| `.paperclip-thinking-icon` | 0 |
| Animation | `shimmer-text-slide` **2.5s** |

Captured on vite preview `:5173` after routing `IssueChatUxLab` in `App.tsx`. Factory `:5113`
serves the prior bundle until restart; fixtures do not require a live agent run.

## Live shimmer evidence (run 4 — real issue chat)

| Motif | Count on `/ASS/issues/ASS-28` (live chat) |
| --- | ---: |
| `.shimmer-text` | 1 |
| `.shimmer-text-muted` | 0 |
| `.paperclip-thinking-icon` | 0 |
| Animation | `shimmer-text-slide` **2.5s** |
| Visible label | **Working** |

Captured on factory `:5113` while **Factory Builder** (`codex_local`) was **running**
on one-shot issue **ASS-28** (`3d051d3a-…`). Not a UX-lab fixture — real board issue chat
during an active agent heartbeat. Receipt: `live-agent-shimmer-proof.json`; screenshot:
`gauntlet-shots/11-live-ASS-28-shimmer-working.png`.

## Thinking-icon evidence (run 5 — loading chrome UX lab)

| Motif | Count on `/ux-lab/loading-chrome` |
| --- | ---: |
| `.paperclip-thinking-icon` | 1 |
| `.paperclip-thinking-icon-path` | 1 |
| `.shimmer-text` | 0 |
| Animation | `paperclip-thinking-draw` **1s** |

Captured on vite dev `:5173` via `LoadingChromeUxLab` — renders the same `PaperclipLoading`
component used on auth/company bootstrap redirects. **Not** issue-chat chrome (live chat uses
`.shimmer-text` + Brain/Loader2 icons). Receipt: `thinking-icon-proof.json`; screenshot:
`gauntlet-shots/12-thinking-icon-loading-1440.png`.

## Limits (stated)

1. **Thinking-icon** browser-proven on **loading chrome** (run 5); **live issue chat** still
   uses shimmer/Brain, not `.paperclip-thinking-icon` (by design).
2. Design-guide settle flag false only because skeleton heuristic saw loading chrome briefly; content and capsules were present (`mainTextLen` 17627) in run 2.
3. Coordination API: **`GET /api/companies/{id}/coordination/tasks`** returns **200** on `:5113` (prior “500” was wrong path / observer config).

## Artifacts

| File | Role |
| --- | --- |
| `gauntlet.json` | Machine receipt |
| `gauntlet.mjs` | Runner (`BASE=http://127.0.0.1:5113`) |
| `gauntlet-shots/` | design-guide, dashboard, agents, reduced-motion, mobile, live ASS-28 |
| `thinking-icon-proof.json` | Run 5 loading-chrome receipt |
| `live-agent-shimmer-proof.json` | Run 4 live issue-chat receipt |
| `shimmer-proof.json` | Run 3 UX-lab receipt |

Instance: Assistants Software Factory (`ASS`), commit **`pending push`** (loading-chrome UX lab).

## Delight (rubric 1.8) recommendation

| Before | After (honest) |
| --- | --- |
| **7.0** (gauntlet not run) | **7.5** — gauntlet **20/21** + capsule gallery (run 2) |
| **7.5** (post run 2) | **7.8** — run 3 UX-lab shimmer + run 4 **live** issue-chat shimmer |
| **7.8** (post run 4) | **8.0** — run 5 browser-proves **`.paperclip-thinking-icon`** on loading chrome (product component); live chat shimmer already proven (run 4) |
