# Paperclip UI — Awwwards-Grade Design Audit

Date: 2026-08-09
Auditor: fleet design-audit subagent (rubric v1.0, `design-audit-rubric.md`)
App: paperclip-ui — `S:\source\CCAI\Assistants\tools\paperclip\ui` (live at http://127.0.0.1:5113; NOT exercised)
Mode: **CODE-ONLY AUDIT.** No server was started and no browser evidence was captured. Per rubric Section 1 ("Score each dimension against browser evidence") every score below is a **code-inspection estimate**, and **every score of 8 or higher is provisional pending browser proof** (Frontend Proof Bundle + gauntlet scorecard per rubric 2.8).
Adversarial verification (2026-08-09): file references and counts spot-checked against repo HEAD; several counts updated because a concurrent live session is actively growing files (line counts, aria counts, opt-out count). All cited paths/lines below were re-verified to exist as described unless annotated.

---

## 1. Executive summary

Paperclip UI is the strongest design-system codebase in the fleet by a clear margin: a single OKLCH token source with light/dark themes (`ui/src/index.css:22-328`), a two-tier motion-token system with reduced-motion collapsed at the token layer (`ui/src/index.css:198-266,525-548`), Storybook accessibility checks configured as errors (`ui/storybook/.storybook/preview.tsx:418-420`), 75 story suites, a 510-image visual-regression baseline (255 stories x light/dark, `doc/design/CHANGING-THE-UI.md:11`), and a mechanical token gate (`scripts/check-token-gates.mjs`) backed by a written constitution (`DESIGN.md`) and a decision ledger (`doc/design/DECISION-SHEET.md`). The rubric's own fleet note ("visual regression exists only in command-center", rubric Section 4) is stale — Paperclip has it, wired to a pinned baseline manifest. Composite code-estimate: **7.8/10** — high Honorable Mention grade, plausibly Site-of-the-Day grade once browser proof exists. The one change that matters most: **route-level code splitting** — the production bundle ships a single 6.4 MB main JS chunk (`ui/dist/assets/index-yWzN2JMo.js`, 6,403 KB) because `App.tsx` statically imports ~80 pages with exactly one `lazy()` in the whole tree (`ui/src/pages/Agents.tsx:42`); this is the only dimension scoring below 7. House-rule violations found: 16 native `window.confirm()`/`confirm()` call sites for consequential actions (grep-verified at HEAD) despite an owned `alert-dialog.tsx` primitive (EUX-09 / rubric 1.5 anchor-3), the known bespoke-table debt (22 files at HEAD) with no `table.tsx` primitive, ~3,100 Tailwind palette-class sites (acknowledged, scheduled as "Run 4" in `DESIGN.md:30`), and two doctrine conflicts (Inter font, multi-hue agent gradients) that are deliberate live conventions and are flagged, not resolved, per rubric 2.9.

## 2. Current-state assessment

### Stack and token audit
- **Stack:** React 19 + Vite 6 + Tailwind v4 + shadcn (new-york, neutral, CSS variables) + Radix + Lucide + CVA + cmdk + TanStack Query + react-router 7 + react-i18next (`ui/package.json:30-86`, `ui/components.json`). Vite is tolerated here as the adopted-repo exception to the fleet's Next-first stack rule (rubric 2.1); the repo's own conventions govern (rubric 2.4).
- **Token source is single and real:** `ui/src/index.css` is the only token root (no tailwind config file; Tailwind v4 `@theme inline` mapping at `index.css:22-70`). Tiers: shadcn semantic core in OKLCH with `.dark` overrides (`index.css:72-328`); brand tier — 10 two-stop agent gradients `--agent-1a..10b` ("the capsule is the agent", `index.css:124-147`) and WCAG-annotated status hues (`--status-task-*`, `--status-agent-*`, `index.css:149-184` — per-token contrast ratios documented inline, e.g. "gray darkened — 7.21:1 on paper" at `index.css:177`); domain tier — chip-match, annotation-highlight, folder, and sizing tokens.
- **Radius is one knob:** multiplicative ladder sm→4xl derived from a single `--radius` (`index.css:57-69`), with the rationale and the decision reference (DECISION-SHEET B4) in the comment.
- **Motion tokens:** primitives (`--motion-duration-*`, `--motion-ease-*`) + state-scoped tokens, deliberately in `:root` not `@theme inline` so a dev tweak panel can retune them live (`index.css:198-266`; rationale in `DESIGN.md:60-84`). A check script rejects hardcoded `ms`/`cubic-bezier` outside index.css (`DESIGN.md:75-78`). Reduced motion zeroes the primitives at the token layer, cascading everywhere, with a documented exception for the interstitial dwell because it is "a pacing hold, not a movement" (`index.css:525-548`).
- **Dark mode:** dark-first product (Storybook default theme dark, `preview.tsx:404`), both themes complete, `color-scheme` set per mode (`index.css:73,419`). Dark background is `oklch(0.145 0 0)` — no pure black (`index.css:270`).
- **Acknowledged token debt:** ~3,100 Tailwind palette-class sites (`bg-red-500` style) are documented as in-scope debt scheduled for a dedicated cluster-by-cluster pass — "piecemeal fixes will collide with it" (`DESIGN.md:30`, `doc/design/CHANGING-THE-UI.md:68-74`). `TOKEN-AUDIT.md` (84 KB) and the machine-readable allowlist inside index.css (`index.css:2288+`) track every intentional literal.

### Live conventions inventory
- Governance documents an agent can actually follow: `DESIGN.md` (repo root, 8 numbered principles, enforcement section), `doc/design/CHANGING-THE-UI.md` (the three commands: `check:token-gates`, `test:storybook-visual`, `:update`), `doc/design/DECISION-SHEET.md` (41 KB decision ledger), `doc/design/COMPONENT-INVENTORY.md` (41 KB), `doc/design/KNOWN-DUPLICATES.md` (deliberate non-merges, e.g. ChatComposer vs MarkdownEditor composer per PAP-101), plus a repo-local `design-guide` Claude skill (`.claude/skills/design-guide/`) with a component index and a living `/design-guide` showcase route (`ui/src/pages/DesignGuide.tsx`, 2,056 lines at HEAD).
- Component tiers: 26 shadcn-style primitives in `ui/src/components/ui/` (including `alert-dialog.tsx`, `command.tsx`, `sheet.tsx`, `skeleton.tsx`, `radio-card.tsx`, `toggle-switch.tsx`), ~309 non-test custom components in `ui/src/components/`, 214 page files under `ui/src/pages/`. 441 test files sit alongside (vitest + Storybook).
- In-code decision annotations exist — e.g. `// design-allow(pill-pattern): DECISION-SHEET.md C8` on `StatusBadge.tsx:28-29` — the exact "mechanical guard + recorded rationale" pattern rubric 1.4 anchor-9 asks for.
- Status is systematic: one hue vocabulary consumed via a `--sc` local-variable `color-mix` recipe (`.status-chip`/`.status-fill`, `index.css:1841+`), color-blind-safe distinct shapes per status (`StatusGlyph`, referenced at `StatusBadge.tsx:86-99`), cancelled is struck through, agent liveness pulses honor reduced motion (`StatusBadge.tsx:61-76`).

### States coverage
- **Loading:** `PageSkeleton.tsx` ships seven layout-matched variants (dashboard/approvals/costs/inbox/org-chart/detail/issues-list) — skeletons match final layout as rubric 1.6 anchor-6 requires (`ui/src/components/PageSkeleton.tsx:15-180`).
- **Empty:** `EmptyState.tsx` carries title/message/description plus a next-step CTA (`ui/src/components/EmptyState.tsx:18-51`).
- **Error:** `RouteErrorBoundary` wraps routes (`ui/src/components/Layout.tsx:22`); toasts via a `ToastViewport` (`Layout.tsx:17`).
- **Live data:** shared polling with leader election and event-sourced live updates instead of per-tab interval churn (`ui/src/components/Sidebar.tsx:66-83` — "no interval poll needed... major source of steady-state churn"); incremental render windows on unbounded feeds with counts ("Rendering 100 of 220 tasks" asserted in `ui/src/components/IssuesList.test.tsx:1413`; pattern documented at `ui/src/pages/WhatNeedsMe.tsx:56-63`). "Showing N of M" is a tested convention (`ui/src/pages/Workspaces.test.tsx:199`, `ui/src/components/KanbanBoard.test.tsx:131`).
- **Keyboard:** global shortcuts hook with g-chords and input-target guards (`ui/src/hooks/useKeyboardShortcuts.ts:30-100`), a shortcuts cheatsheet (`Layout.tsx:16`), and a cmdk command palette (`ui/src/components/CommandPalette.tsx`, 450 lines at HEAD).

### Preflight / proof-bundle record check
- No `Test-FrontendComponentSourcingPreflight` record exists in-repo (bounded search over repo markdown; only rubric-external hits). Paperclip predates and sits outside the agent-settings preflight process — it is itself the ladder's rung-3 pool. Its internal equivalent (token gates + visual baseline + DECISION-SHEET) is materially stronger than a preflight note, but any NEW operator-UI work driven from the fleet side should still file one. **Status: not-recorded (flagged, not a fail for pre-existing surfaces).**
- Proof culture exists: `screenshots/` holds per-PR before/after captures (e.g. `PAP-10535-live-run-menu-before/after.png`), `design/pap-14557-monitor-visibility/` holds wireframes and current-state screenshots, and the visual baseline manifest is the standing proof mechanism (`doc/design/CHANGING-THE-UI.md:11,53-58`). No proof bundle exists for *this* audit — code-only.

### Duplication vs fleet primitives
- The known fleet debt is confirmed at head: 22 files contain bespoke `<table>` markup (grep over `ui/src` at HEAD, non-test; list includes `ui/src/pages/AgentDetail.tsx`, `ui/src/pages/Pipelines.tsx`, `ui/src/pages/apps/gateways/GatewaysList.tsx`, `ui/src/pages/tools/*.tsx`) and there is **no `table.tsx`** among the 26 primitives in `ui/src/components/ui/`. `MarkdownBody.tsx` is a react-markdown renderer emitter (noise, per rubric Section 4) — ~20 real debt files.
- Hand-rolled cards/pills → `Card`/`Badge` convergence is already queued in-repo (`doc/design/CHANGING-THE-UI.md:71`), and `KNOWN-DUPLICATES.md` documents the deliberate non-merges. This is governed debt, not silent drift.

## 3. Scorecard

All scores are code-inspection estimates; scores >= 8 are **provisional pending browser proof**.

| Dimension | Score (0-10) | Evidence |
|---|---|---|
| Visual craft | 8 (provisional) | Single OKLCH token source, both themes (`ui/src/index.css:72-328`); one-knob radius ladder (`index.css:57-69`); WCAG-annotated status hues (`index.css:167-184`); no pure black (`index.css:270`); minimal shadows (`shadow-xs/sm` only, design-guide skill sec. 3). Held back by ~3,100 palette-class sites (`DESIGN.md:30`), hardcoded `bg-zinc-950` on InviteLanding (`ui/src/pages/InviteLanding.tsx:166,474,500,533`), and stock-shadcn purple `--sidebar-primary` in dark (`index.css:297`). |
| Motion & interaction | 8 (provisional) | Two-tier motion tokens, runtime-tunable, house curves (`index.css:198-266,666-681`); no-hardcoded-timing check script (`DESIGN.md:75-78`); reduced-motion at token layer + per-animation guards (`index.css:525-548,626-644,765-772,810-842`); transform/opacity discipline incl. pure-translate ticker (`index.css:816-842`) and grid-rows fold trick (`index.css:611-620`); deliberate quicklook scale-out with documented reasoning for NOT adopting tailwindcss-animate (`index.css:724-763`). Nit: `dashboard-activity-enter` animates `filter: blur()` (`index.css:775-791`). 60fps under load unproven — a dev perf lab exists (`ui/src/pages/IssueChatLongThreadPerf.tsx`, route gated `import.meta.env.DEV`, `App.tsx:195-197`). |
| IA & user flows | 8 (provisional) | The operator questions are constitutional: "what is happening, does it need me, what do I do about it" (`DESIGN.md:13`); dedicated attention surfaces — Inbox, WhatNeedsMe, DecisionQueuePage (`App.tsx:45-47`); three-zone shell + breadcrumbs + properties panel (design-guide sec. 9, `Layout.tsx`); cmdk palette + g-chords + cheatsheet (`useKeyboardShortcuts.ts:30-100`); "Showing N of M" tested (`Workspaces.test.tsx:199`); route separation is real (~80 routes, `App.tsx:102-220`); MobileBottomNav (`Layout.tsx:18`). Held back by 5,337-line `IssueDetail.tsx` / 4,360-line `AgentDetail.tsx` monoliths (counts at HEAD; still growing under the live session) and the unfinished issue→task vocabulary rename (`DESIGN.md:35`). |
| Design-system consistency | 8.5 (provisional) | Best-in-fleet mechanical guards: `pnpm check:token-gates` (`scripts/check-token-gates.mjs`), 510-image visual baseline (`doc/design/CHANGING-THE-UI.md:11`), in-code `design-allow(...)` annotations tied to a decision ledger (`StatusBadge.tsx:28-29`, `doc/design/DECISION-SHEET.md`), component inventory + known-duplicates registry, codemod-not-hand-edit rule (`DESIGN.md:42`). Debt is documented, scheduled, and gated rather than silent. Held back by the 22-file table debt (no `table.tsx` primitive) and palette-class debt. |
| Accessibility | 8 (provisional) | Storybook a11y `test: "error"` globally (`preview.tsx:418-420`) — the rubric's own named "Paperclip standard" — with 7 story-level opt-outs to burn down (`agent-detail.stories.tsx:194`, `routine-detail-c.stories.tsx:447`, `routine-secrets.stories.tsx:53`, `secrets.stories.tsx:125`, `user-secrets.stories.tsx:144`, `environment-variables-editor.stories.tsx:95`, `file-viewer.stories.tsx:219`); 1,730 `aria-` occurrences across 367 files; Radix primitives underneath; 44px coarse-pointer floor with documented dense-row exceptions (`index.css:387-415`); WCAG 2.5.5 comment on chip targets (`index.css:1790`); color-blind-safe status shapes (`StatusBadge.tsx:86`); AA-tuned icon hues per mode (`index.css:167-184,320-327`). Hard fail vector: 16 native `window.confirm()`/`confirm()` sites for consequential actions (`ui/src/pages/ApprovalDetail.tsx:315`, `ui/src/pages/AgentDetail.tsx:2836,3495`, `ui/src/pages/SkillStudio.tsx:1326,1683,1958,2545`, `ui/src/components/ProjectProperties.tsx:515,526`, `ui/src/components/AgentActionButtons.tsx:300`, others — full list in improvement 9) while `ui/src/components/ui/alert-dialog.tsx` sits owned and idle for those sites — rubric 1.5 anchor-3. |
| Perceived performance | 6 | Skeletons match layout (`PageSkeleton.tsx:15-180`); leader-elected shared polling + event-sourced live updates (`Sidebar.tsx:66-83`); incremental render windows (`WhatNeedsMe.tsx:56-63`); mermaid dynamically imported (`MarkdownBody.tsx:91,198`); `drop: ["console","debugger"]` in prod (`ui/vite.config.ts:15-21`). BUT: single 6,403 KB main JS chunk + 425 KB CSS (`ui/dist/assets/`), ~80 statically imported pages with one `lazy()` total (`App.tsx:1-100`, `Agents.tsx:42`); MDXEditor/lexical/xterm ride the main chunk (`ui/src/pages/CompanyEnvironments.tsx:10-11`, `MarkdownEditor.tsx:39`). Local-first deployment softens but does not excuse cold-load cost. |
| Content & microcopy | 7.5 | Full i18n: 20+ locale files under `ui/src/i18n/` with locale validation tests; shared formatters `formatCents`/`relativeTime`/`formatTokens` (design-guide skill, `ui/src/lib/utils.ts`); words-as-system principle with action-naming rule ("Approve hire," not "Submit") (`DESIGN.md:35`); counts in summaries tested ("Accepted 1 of 2 tasks", `issue-thread-interactions.test.ts:91`). Held back by the live issue/task vocabulary split (canonical term is *task*; routes, components, and copy still say Issue — `DESIGN.md:35` defers the rename) and native-confirm prose for destructive flows. |
| Delight / signature moments | 8 (provisional) | Brand-anchored, not Dribbblised: the paperclip-drawing "thinking" icon (`index.css:869-903`), the agent-capsule motif with gradient identity and heartbeat pulse states (`index.css:124-147,966-1071`; PAP-75/PAP-119), Cursor-style shimmer on working states with a muted subordinate tier (`index.css:844-931`), choreographed dashboard activity entry (`index.css:774-814`). All survive reduced motion via explicit guards. Complexity sits at the right ladder rung (CSS/DOM, no WebGL). Needs browser/gauntlet proof to claim more. |

**Composite (Awwwards weighting, Design 40 / Usability 30 / Creativity 20 / Content 10):**
Design ≈ (8 + 8.5 + 8)/3 = 8.2; Usability ≈ (8 + 8 + 6)/3 = 7.3; Creativity ≈ 8; Content ≈ 7.5.
**Composite ≈ 7.8/10** — code-inspection estimate, provisional pending browser proof.

## 4. Improvements

Ordering: highest leverage first within each tier. Every "How" names its sourcing-ladder lane (rubric 2.2). Live conventions win: this repo's own primitives and token system are rung 1 and are usually the terminal answer.

### Quick wins

1. **Stop animating `filter: blur()` in the dashboard activity entry.**
   Where: `ui/src/index.css:775-791` (`dashboard-activity-enter` keyframe).
   How: rung 1 (target-app motion tokens) — drop the blur stops, keep translateY/scale/opacity; the highlight keyframe already carries the attention cue. Compositor-only motion per rubric 2.6.
   Impact: quick-win.

2. **Tokenize InviteLanding's hardcoded `bg-zinc-950` page shell.**
   Where: `ui/src/pages/InviteLanding.tsx:166,474,500,533`.
   How: rung 1 — `bg-background` + `.dark` scope or a `--landing-*` token per DESIGN.md Principle 2; run `pnpm check:token-gates` and the visual baseline to prove the swap.
   Impact: quick-win.

3. **Retire the stock-shadcn purple `--sidebar-primary` in dark mode.**
   Where: `ui/src/index.css:297` (`oklch(0.488 0.243 264.376)`) — the only saturated non-status, non-brand accent in the semantic tier; a leftover preset value in an otherwise neutral system.
   How: rung 1 — repoint at the neutral primary or a brand hue via Recipe 1 (`doc/design/CHANGING-THE-UI.md:23-32`); token edit + snapshot diff only.
   Impact: quick-win.

4. **Replace the `⚠` text glyph in ResourceStatusChip with the repo's icon convention.**
   Where: `ui/src/components/ResourceStatusChip.tsx:37-38,61`.
   How: rung 1 icon convention (Lucide is the declared library, `ui/components.json:20` — `AlertTriangle` at the 14px inline size per design-guide sec. 2). Anti-emoji policy (rubric 2.6) bans dingbats in markup; remaining hits (`TaskChatThread.tsx:403,413` etc.) are code comments only — leave them.
   Impact: quick-win.

5. **Burn down the seven Storybook a11y opt-outs.**
   Where: `ui/storybook/stories/agent-detail.stories.tsx:194`, `routine-detail-c.stories.tsx:447`, `routine-secrets.stories.tsx:53`, `secrets.stories.tsx:125`, `user-secrets.stories.tsx:144`, `environment-variables-editor.stories.tsx:95`, `file-viewer.stories.tsx:219` (`a11y: { test: "off" | "todo" }`).
   How: rung 1 — fix the violations and delete the overrides so the global `test: "error"` (`preview.tsx:418-420`) is unconditional; each opt-out is a hole in the app's flagship a11y guarantee.
   Impact: quick-win.

6. **Round the EmptyState icon tile to match the radius ladder.**
   Where: `ui/src/components/EmptyState.tsx:29` — `bg-muted/50 p-4` renders a square tile in a system whose every other container carries a `rounded-*` step.
   How: rung 1 — `rounded-full` (matches status dots/avatar language) or `rounded-lg`; verify against the `/design-guide` page and snapshot baseline.
   Impact: quick-win.

### Medium

7. **Route-level code splitting — the single highest-leverage change in this audit.**
   Where: `ui/src/App.tsx:1-100` (~80 static page imports; only `ui/src/pages/Agents.tsx:42` uses `lazy()`); result is the 6,403 KB `ui/dist/assets/index-yWzN2JMo.js`.
   How: rung 1 (framework-native, no new deps) — `React.lazy` + `Suspense` per route group with `PageSkeleton` as the fallback (the skeleton variants already exist per page family, so perceived cost is near zero). Start with the heaviest leaves: MDXEditor surfaces (`MarkdownEditor.tsx:39`), xterm (`CompanyEnvironments.tsx:10-11`), SkillStudio, DesignGuide, UxLab pages. The mermaid dynamic-import pattern (`MarkdownBody.tsx:91,198`) is the in-repo precedent to copy.
   Impact: medium (flagship-level payoff, medium effort).

8. **`shadcn add table`, migrate the ~20 real bespoke tables, then ratchet.**
   Where: 22 files with `<table>` at HEAD (e.g. `ui/src/pages/AgentDetail.tsx`, `ui/src/pages/Pipelines.tsx`, `ui/src/pages/CompanyInvites.tsx`, `ui/src/pages/apps/gateways/GatewaysList.tsx`, `ui/src/pages/tools/RuntimeTab.tsx` and siblings, `ui/src/pages/apps/Connections.tsx`); no `table.tsx` in `ui/src/components/ui/`.
   How: rung 4 (shadcn/ui — the repo has `components.json`, so shadcn/Blocks-first applies per rubric Section 4), styled through the repo's tokens; adopt TanStack Table (rung 6, already the fleet grid pattern via MCK's DataTable) only where real grid state exists (Costs, GatewaysList). Order is primitive-then-ratchet per the fleet rule — copy the ~90-line ratchet recipe repo-local, never share the code. Exclude `MarkdownBody.tsx` renderer emitters from the count.
   Impact: medium.

9. **Replace the 16 `window.confirm()` sites with the owned AlertDialog.**
   Where: `ui/src/pages/ApprovalDetail.tsx:315`, `ui/src/pages/AgentDetail.tsx:2836,3495`, `ui/src/pages/SkillStudio.tsx:1326,1683,1958,2545`, `ui/src/pages/CompanyEnvironments.tsx:1451,1493`, `ui/src/pages/CompanySettings.tsx:603`, `ui/src/pages/InstanceSettings.tsx:191`, `ui/src/components/ProjectProperties.tsx:515,526`, `ui/src/components/AgentActionButtons.tsx:300`, `ui/src/components/DevRestartBanner.tsx:57`, `ui/src/pages/secrets/ImportFromVaultDialog.tsx:616`.
   How: rung 1 — `ui/src/components/ui/alert-dialog.tsx` already exists; wrap it once as a `useConfirmDialog` composite (design-guide sec. 6 tier-2 pattern) so call sites stay one-liners. Fixes rubric 1.5 anchor-3 and EUX-09 in one pass; mirrors memsys#212's fleet precedent.
   Impact: medium.

10. **Finish the issue→task vocabulary run.**
    Where: `DESIGN.md:35` declares *task* canonical and explicitly deferred the visible rename; user-facing copy, routes (`/issues`, `App.tsx:187-194`), and component names still say Issue.
    How: rung 1 — copy-only pass through the i18n catalogs (`ui/src/i18n/*.json`) first (all 20+ locales), keeping route slugs and code identifiers for a later mechanical codemod per the repo's codemod convention (`DESIGN.md:42`). Visible change: needs its own visual-baseline update per Recipe 4.
    Impact: medium.

11. **Unify the incremental-render window into one shared hook.**
    Where: the pattern is hand-copied — "same pattern as IssuesList" at `ui/src/pages/WhatNeedsMe.tsx:56-63` with its own scroll-container walker (`WhatNeedsMe.tsx:76-80`); IssuesList and KanbanBoard carry siblings (tests at `IssuesList.test.tsx:1413`, `KanbanBoard.test.tsx:131`).
    How: rung 1 extraction — one `useIncrementalRows` hook in `ui/src/hooks/` capturing limit/batch/threshold + the "Rendering N of M" counter line; DESIGN.md Principle 1 ("one way to say each thing") applied to behavior.
    Impact: medium.

12. **Promote the status system and motion-token pattern to Component Marketplace.**
    Where: `StatusGlyph` + `.status-chip` color-mix recipe (`ui/src/components/StatusBadge.tsx`, `ui/src/lib/status-colors.ts`, `index.css:1841+`) and the motion-token architecture (`index.css:198-266`).
    How: rung 2 (Component Marketplace is the canonical reuse home) — normalize into the operator barrel next to `OperatorBadge`; curate only the needed pieces per the rubric's Paperclip rule ("curate and normalize only the needed component; do not import the whole domain package"). This is rubric 1.4 anchor-9's "extracted back to Component Marketplace instead of stranded in one app", and it upgrades the whole fleet's status vocabulary to a WCAG-annotated, color-blind-safe standard.
    Impact: medium (fleet-level payoff).

13. **Add View Transitions to route changes as progressive enhancement.**
    Where: shell-level navigation (`ui/src/components/Layout.tsx`, `ui/src/App.tsx`); today route swaps are hard cuts.
    How: native View Transitions API lane (rubric shortlist; Chrome 126+/Safari 18.2) driven by the existing motion tokens (`--motion-duration-fast`, `--motion-ease-out-expo`) with `prefers-reduced-motion` and unsupported-browser no-ops. No dependency added — consistent with the repo's documented refusal of tailwindcss-animate for one surface (`index.css:727-736`). Do NOT add Motion/GSAP; the repo's own tokenized-CSS system is the live convention and it is working.
    Impact: medium.

### Flagship

14. **The Org Pulse — see Section 5.**
    Impact: flagship.

15. **Split the IssueDetail/AgentDetail monoliths along their tab seams.**
    Where: `ui/src/pages/IssueDetail.tsx` (5,337 lines at HEAD), `ui/src/pages/AgentDetail.tsx` (4,360 lines at HEAD).
    How: rung 1 — the tab-route seams already exist (`agents/:agentId/:tab`, `App.tsx:175`); extract per-tab panels into `ui/src/components/` composites (the `AgentToolsTab.tsx` extraction is the in-repo precedent), which also unlocks per-tab lazy loading compounding improvement 7. Memsys#206 (splitting a 4,197-line page) is the fleet precedent.
    Impact: flagship (structural, multi-session).

## 5. Awwwards flagship concept — "The Org Pulse"

**One signature moment, scoped to the app's real job:** the operator opens the Dashboard and, in a single choreographed data-reveal, *sees the company breathing* — every agent rendered as its brand capsule (the existing `--agent-Na/Nb` gradient motif, `index.css:124-147`), arranged as a compact pulse strip above the metric grid. Each capsule carries its live status via the existing heartbeat grammar (running pulses, error blinks — `index.css:966-1071`); capsules needing a decision rise to the front of the strip with the `tc-fade-rise` grammar and a one-line reason ("Awaiting approval — hire request, 2h"). Clicking (or pressing Enter on) a capsule opens the existing quicklook popover (`index.css:738-763`) with the decision action inline — decision in one glance, action in one interaction (rubric 1.3 anchor-9). The moment IS the operator decision surface, not decoration: attention-sorted liveness answering "does it need me" before a single table renders.

- **Complexity level (cinematic ladder):** CSS/DOM tier — the lowest level that satisfies the audience and the job. No WebGL, no canvas, no scroll choreography. Everything composites from existing keyframes and motion tokens.
- **Asset/motion plan:** zero new assets (capsule gradients, hb-pulse, agent-cap-rise, quicklook-open all exist in `index.css`); one new component (`OrgPulseStrip`) in `ui/src/components/`, entry stagger driven by `--motion-plan-entry-stagger`, sort choreography via FLIP-on-transform only. New tokens (`--motion-pulse-*`) added to the `:root` motion block per DESIGN.md motion rules — no hardcoded timing, tweak-panel tunable, gated by the existing check script.
- **Reduced-motion fallback:** capsules render static with their status fill and an attention-count badge; sort order still front-loads decisions; quicklook opens without scale animation (all guards already exist in the token layer, `index.css:528-548`).
- **Proof it needs:** frontend-sota-gauntlet scorecard at 19-21/21 with browser evidence; Frontend Proof Bundle (desktop 1440x900 + mobile 390x844, dark, reduced-motion variant); a 60fps trace on `dashboard` with 10+ concurrent live runs (use the shared-polling harness; never `networkidle` on this live-polling surface); a11y pass with the story's `a11y: test: "error"` intact.

## 6. Constraint compliance notes

| Constraint | Status | Notes |
|---|---|---|
| Stack rule (2.1) | PASS with standing exception | Vite (`ui/vite.config.ts`) is non-sanctioned fleet-wide but explicitly tolerated for this adopted repo per the audit charter; evolve in place, no framework replacement proposed. Flag: any *new* fleet surface copying Paperclip patterns must not inherit Vite. |
| Sourcing ladder + preflight (2.2/2.3) | PARTIAL — not-recorded | No preflight records in-repo (see Section 2). The repo's internal gates (token gates, visual baseline, DECISION-SHEET, KNOWN-DUPLICATES) exceed the preflight's intent for in-repo work; recommendations above each name their lane. Rung-1-first is genuinely practiced here (`design-allow` annotations, component inventory). |
| Paid-tool policy (2.7) | PASS | Dependencies are MIT/OSS (`ui/package.json`); Inter is vendored with a fonts NOTICE (`ui/public/fonts/NOTICE.md`); no paid pools, kits, or license-unclear code found. |
| Ethical UX (2.5, report-only) | PASS with one HIGH finding, one unverified | EUX-09 (consequential action review): **fail-leaning** — 16 native `confirm()` sites (Section 4, item 9); copy is honest but the mechanism is not an accessible review dialog. EUX-02 honest progress: pass — skeletons, real counts, no fake progress found. EUX-04 truthful urgency: pass — no countdowns/scarcity anywhere. EUX-01/03/05-08/10: no violations found in code; **unverified** without browser proof (missing proof = unverified, never a pass). |
| Anti-slop bans (2.6) | MOSTLY PASS, 2 doctrine conflicts + 3 nits | No pure black (`index.css:270`); no AI-purple gradient aesthetic (neutral OKLCH; one stock purple token nit, `index.css:297`); no serif UI; no scrolljacking found; no `h-screen` (only `min-h-screen` on 4 lab/landing pages — app shell uses `overflow:hidden` + `100dvh` tokens, `index.css:262,363`); transform/opacity discipline held except the blur keyframe (`index.css:775-791`) and grid-rows fold (sanctioned technique, documented `index.css:611-620`); one `⚠` text-glyph in markup (`ResourceStatusChip.tsx:37`). **Conflicts flagged, not resolved (2.9):** (a) the NO-Inter ban vs the repo's vendored InterVariable brand font (`index.css:4-23`); (b) Max-1-Accent vs the 10 brand agent gradients (`index.css:124-147`) — a deliberate, documented brand system ("the capsule is the agent"). Live convention wins pending operator ruling. |
| Proof bundle (2.8) | NOT PRODUCED — code-only audit | No server started per charter. All scores are code-inspection estimates; every 8+ is provisional. The repo's own 510-image baseline is standing visual proof of *consistency*, not of this audit's scores. Next step: run the proof bundle + gauntlet against http://127.0.0.1:5113 (Playwright from the content-factory tree; never `networkidle` on the live-polling dashboard). |

## 7. Open questions for the operator

1. **Inter ban vs InterVariable brand:** taste-skill bans Inter outright; Paperclip vendors InterVariable as its brand face (`ui/src/index.css:4-23`). Rule on which wins for this repo — and whether the fleet ban gets an adopted-repo carve-out.
2. **Agent gradients vs Max-1-Accent:** the 10 two-stop capsule gradients are the product's brand signature and violate the single-accent rule by design. Confirm the brand system as a sanctioned exception (recommended) or schedule a brand revision.
3. **Icon doctrine:** Lucide is this repo's declared convention (`ui/components.json:20`), consistent with the fleet default but against taste-skill's Phosphor/Radix mandate — recorded as the live convention per rubric 2.9; needs a fleet-level ruling.
4. **Bundle budget for local-first apps:** is a 6.4 MB main chunk acceptable for the local/Docker deployment model, or does improvement 7 get scheduled now? Recommend now — it also unlocks per-tab splitting of the monolith pages.
5. **Table migration ownership/timing:** `shadcn add table` → migrate ~20 files → ratchet is the agreed fleet ordering; the repo also has its own queued component-convergence pass (`doc/design/CHANGING-THE-UI.md:71`). Who owns sequencing these so they don't collide? A LIVE concurrent agent session is working in this repo — coordinate before any implementation.
6. **Task rename run:** DESIGN.md Principle 7 defers the visible issue→task copy rename to its own run. Green-light it (with baseline update) or leave parked?
7. **Fleet extraction approvals:** promote StatusGlyph + `.status-chip` recipe, the motion-token architecture, and the `useIncrementalRows` pattern to Component Marketplace (improvement 12)? Paperclip is already the designated rung-3 pool; extraction would make these rung-2.
8. **Rubric correction:** the fleet note "Visual regression exists only in command-center" (rubric Section 4 fleet-wide debts) is contradicted by Paperclip's 510-image baseline system (`doc/design/CHANGING-THE-UI.md:11`, `tests/storybook-visual/`). Update the rubric so future audits copy the recipe from here too.
9. **Browser-proof follow-up:** approve a proof-bundle + gauntlet session against http://127.0.0.1:5113 to convert the provisional 8s into evidenced scores (or revise them downward honestly).
