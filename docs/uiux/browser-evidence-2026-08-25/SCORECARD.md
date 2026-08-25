# Paperclip UI — measured re-score, 2026-08-25

**Verdict: 7.7 → 7.2. The score moves DOWN, and that is the result.**

The 7.7 was a code-inspection estimate carried for ten fleet rounds. Its own
report flagged every score of 8 or higher as "provisional pending browser
proof". This is that proof, and it does not confirm the provisional half of the
estimate. Two dimensions fall on measured evidence, one rises on a verified
remediation, and one is explicitly *not* re-scored because the harness cannot
see it.

A measured 7.2 is worth more than a carried 7.7.

---

## 1. What was measured, and what the run is allowed to claim

| | |
|---|---|
| Surfaces attempted | **86** (68 capturable static + 18 dynamic the instance could reach) |
| MEASURED | **80** |
| NO-CONTENT | 6 |
| INCONCLUSIVE | **0** (exit 0) |
| **Distinct rendered views** | **74** — 13 surfaces redirected, 6 onto a view another surface already reached |
| Content gate proven able to fail | **yes**, against the app's own 404 surface, captured live in the same run |
| Overflow detector | **elected by the control per surface**; `mainScroll` won on 80/80 |
| Viewport | 1440x900, light scheme, `pointer: fine` (plus a 24-surface dark pass and a 24-surface 390x844 touch-emulated pass, §3.1) |
| Code identity | `ui/` byte-identical to `origin/dev`; no `ui/` commit and no working-tree change after the bundle was built (`provenance.json`) |

Route derivation: **219** `<Route>` records — 72 static, 46 dynamic, 91
redirect, 6 splat, 4 layout. **28 of the 46 dynamic patterns are unreachable**
on this instance (no approval, plugin, gateway, application, case or token
entities exist to address them); they are listed by name in the capture JSON.
That gap is stated, not absorbed into a denominator.

**Prior surface figure.** The fleet register records "126 capturable surfaces".
This derivation gives 68 production static + 46 distinct dynamic patterns = 114
distinct patterns, or 124 if the 6 splats and 4 layout mounts are counted.
The difference is a de-duplication rule, not a contradiction: 126 counts route
*declarations* including duplicate mounts and DEV-only routes. Not treated as a
refutation.

---

## 2. Scorecard

| Dimension | 2026-08-09 (code-only) | Measured | Δ | Evidence |
|---|---|---|---|---|
| Visual craft | 8 *(provisional)* | **7.5** | −0.5 | Body family `InterVariable` on 80/80 surfaces. Type scale coherent (7–8 distinct rendered sizes on 59/80). **But `h1` renders at five different computed sizes — 14px on 32 surfaces, 18px on 13, 20px on 6, 24px on 14, 24.5px on 2 — and 13 of 80 surfaces have no `h1` at all.** A 14px `h1` on 40% of the app is not a hierarchy a user feels. |
| Motion & interaction | 8 *(provisional)* | **7.5** | −0.5 | 75 animated elements, 34 infinite. Under `prefers-reduced-motion: reduce` the media query is active on every sampled surface and animation collapses on 5 of 6 — **but `animate-spin` keeps running (2 infinite SVG spinners), and 72–113 elements per surface still carry a non-zero `transition-duration`.** `DESIGN.md` claims the token-layer collapse cascades everywhere; measured, it does not reach Tailwind utility timings. |
| IA & user flows | 8 *(provisional)* | **7.5** | −0.5 | Route separation is real and now proven: 74 distinct rendered views across 86 attempts, 0 inconclusive. **But 6 surfaces redirect onto a view another route already renders**, and `/projects/:id`, `/projects/:id/issues` and `/projects/:id/workspaces` all land on the same issues view — three declared routes, one screen. |
| Design-system consistency | 8.5 *(provisional)* | **8.0** | −0.5 | The mechanical guards are real and unchanged (`check:token-gates`, 510-image visual baseline, decision ledger, component inventory). Browser proof supports uniform token application: one body family, one radius language, zero overflow. Held back by the measured `h1` scale inconsistency above — a token *applied* inconsistently — and the unchanged 22-file bespoke-table debt with no `table.tsx` primitive. |
| Accessibility | 8 *(provisional)* | **6.5** | **−1.5** | See §3. The single largest move, in both directions. |
| Perceived performance | 6 | **5.5** | −0.5 | Measured cold load of the board dashboard over loopback (`loadcost-dashboard.json`): **41 requests, 7,628,622 B (7.28 MiB) transferred**, of which **one JS file is 6,779,424 B (6.46 MiB)** — so the monolithic chunk is what the client actually pulls, not just what sits in `dist`. Plus 456,116 B CSS, 352,240 B font, and **37 separate JSON calls on a single dashboard load**. First text at 1,036 ms; median time to *settled* text 2,313 ms, p90 3,257 ms, **3 surfaces never quiesced inside a 20 s ceiling**. The chunk is also *worse* than the 6,403 KB the code audit measured. |
| Content & microcopy | 7.5 | **7.5 (carried, NOT measured)** | 0.0 | Redaction reduces every string in the output to `{len, sha8}`, so this harness cannot read copy. Carried unchanged and explicitly **not** claimed as measured. |
| Delight / signature moments | 8 *(provisional)* | **7.0** | −1.0 | The motifs are real in code and visible in `shots/`. But rubric 2.8 is explicit: SOTA claims require the frontend-sota-gauntlet scorecard, and the 2026-08-09 report itself said this dimension "needs browser/gauntlet proof to claim more". **The gauntlet was not run.** The provisional 8 cannot be confirmed, so it is not kept. |

**Composite (Awwwards weighting: Design 40 / Usability 30 / Creativity 20 / Content 10)**

- Design = (7.5 visual + 8.0 design-system + 7.5 motion) / 3 = **7.67**
- Usability = (7.5 IA + 6.5 a11y + 5.5 perf) / 3 = **6.50**
- Creativity = **7.0**
- Content = **7.5**
- **Composite = 0.4(7.67) + 0.3(6.50) + 0.2(7.0) + 0.1(7.5) = 7.17 → 7.2**

---

## 3. Accessibility — the dimension that actually moved

**Up, and verified: the hard-fail vector is gone.** The 2026-08-09 audit's
rubric-1.5 anchor-3 finding was "16 native `window.confirm()`/`confirm()` sites
for consequential actions while `alert-dialog.tsx` sits owned and idle". At this
commit there are **zero** `window.confirm(` call sites in `ui/src` outside
comments and the design-guide's own explanatory copy. Every site the audit named
by line — `ApprovalDetail.tsx`, `AgentDetail.tsx` x2, `ProjectProperties.tsx`
x2, `AgentActionButtons.tsx`, the `SkillStudio.tsx` group — now awaits the
promise-based `useConfirmDialog` built on the repo's `AlertDialog`. That is a
real remediation and it is worth real credit.

**Down, and measured for the first time.** Four findings, none of which a code
audit surfaced:

1. **Target size.** Of 4,730 visible interactive targets, **1,422 (30.1%) are
   under the 24x24 CSS px WCAG 2.5.8 AA floor** and **4,528 (95.7%) are under
   the 44x44 px 2.5.5 AAA size** the fleet rubric anchors on. *Which criterion
   was met: neither, at `pointer: fine`.*

   **The fair caveat, stated because it matters.** The app *does* ship a 44px
   floor — but only inside `@media (pointer: coarse)`
   (`ui/src/index.css:388`), with documented exceptions for dense-row widgets.
   A desktop capture never triggers it, so these numbers describe the mouse
   experience, which is the one the rule was deliberately not written for. They
   are still 2.5.8 numbers, because 2.5.8 is not pointer-conditional.
   **What I could not evaluate: the 2.5.8 spacing exception** — a 24px circle
   centred on the target touching no neighbour's — which plausibly covers a
   substantial share of the sub-24px population in dense rows. That share is
   unmeasured, so "30.1% fail" is an upper bound on the defect, not a count of
   it.

2. **Contrast (WCAG 1.4.3), light theme.** With the colour probe corrected to
   100% coverage (§4), **1,192 of 8,892 resolved text nodes (13.4%) fall below
   their required ratio.** The dominant class is not incidental:
   `text-(length:--text-nano) font-medium uppercase` at **10px / weight 500 /
   2.3:1** against a 4.5 requirement — the sidebar section labels, on every
   board surface. `--text-micro` muted text at 11px reads **1.96:1**.
3. **Minimum rendered text.** Global minimum **8px**, median minimum **10px**,
   **1,137 text nodes below 12px**. Rubric 1.5's 3-anchor names "bold tiny
   helper text" explicitly, and the 2.3:1 class above is 10px *and* weight 500.
4. **Structure.** `h1` absent on 13 of 80 surfaces; heading-order breaks on 8;
   `/onboarding` and the ux-lab routes ship **no `<main>` landmark at all**.

Weighing a genuine remediation against four measured defects, three of which
touch rubric 1.5's 3-anchor directly: **6.5**.

### 3.1 Two cross-checks that change how the above should be read

Both were run because a single-condition measurement would have been unfair to
the app, and both moved the answer.

**The coarse-pointer floor works — and still does not reach either criterion.**
Re-captured at 390x844 with touch emulation so `@media (pointer: coarse)`
actually applies (24 surfaces, 20 MEASURED, 0 inconclusive):

| | 1440 `pointer: fine` | 390 `pointer: coarse` |
|---|---|---|
| under 24px (2.5.8 AA) | 30.1% | **20.6%** |
| under 44px (2.5.5 AAA) | 95.7% | **69.4%** |

The floor is real and it moves the numbers substantially. It does not get the
app to 2.5.5 AAA, and one target in five is still under the 2.5.8 AA floor with
the floor active. A capture that had skipped touch emulation would have
reported the fine-pointer column as the whole story and been wrong about the
app's intent.

**The light theme is the weak one.** Same 24 surfaces, dark scheme:

| | light | dark |
|---|---|---|
| text nodes below required ratio | **13.4%** | **5.1%** |

This app is dark-mode-first (Storybook's default theme is dark) and its dark
theme is markedly the better one. Headless Chromium reports
`prefers-color-scheme: light` unless told otherwise, so an unset capture
measures the weaker theme by accident and reports it as *the* contrast figure.
Both are reported here; the accessibility score reflects the light theme,
because it ships.

**The only horizontal overflow found anywhere in the app** is 38px on
`/ux-lab/cross-issue-collaboration` at 390px — a dev lab route, not a product
surface. 0 of 80 board surfaces overflow at 1440.

---

## 4. Detector integrity — four premises the control refuted

None of these numbers would be trustworthy without the controls, and four
detector premises failed on contact with the app. Full narrative in `README.md`
§5; the short version:

1. **Quiescence is not readiness.** React mounts 3–7 s after `commit`. The
   earlier sweep declared 76/76 surfaces settled at ~770 ms and measured
   nothing — body font still `"Times New Roman"`.
2. **No single overflow detector works.** The shell clip container is live on
   board surfaces and dead on standalone ones; on board surfaces `<main>` is
   itself a scroll container, so the control moves *nothing else*. The detector
   is elected per surface by the control. Result: **0/80 surfaces overflow, 0/80
   escape the viewport** — a clean finding that a hard-coded detector would have
   produced by accident and could not have justified.
3. **The contrast probe was 8.3% covered.** An `rgb()` parser cannot read an
   OKLCH token system. Canvas `fillStyle` does **not** fix it — its getter
   round-trips `oklch()` verbatim (measured: `rgb()` → `#09090b`,
   `rebeccapurple` → `#663399`, `oklch()` → itself). Painting one pixel and
   reading it back does. **8.3% → 100%.**
4. **"First ancestor with alpha ≥ 0.95" mis-scored a whole class.** The sidebar
   count badge paints `oklab(0.577 0.217662 0.112464 / 0.9)`; rejected as
   non-opaque, the walk ran past it to the white page, and white-on-red badge
   text was scored against **white at 1.09:1** and reported as a severe failure
   on every board surface. Backgrounds are now composited. This is why §3's
   contrast figure separates 433 genuine readings from 83 unmodelled ones
   (`fg == bg`, i.e. text over a gradient a single colour cannot represent).

A fifth defect was **reported by a peer session and confirmed here against the
capture data before being fixed**: the outcome label never consulted
`redirected`, so `/auth` — which redirects onto the board dashboard under
`local_trusted` — passed the content gate on the *dashboard's* text and was
counted as its own MEASURED surface. Measured: 13 of 80 redirected, 6 onto an
already-counted view. That is why this report leads with **74 distinct rendered
views, not 80**.

---

## 5. Limits of this run — stated, not buried

- **Content & microcopy is not measured.** Redaction is deliberate (public repo)
  and it costs this dimension. Carried at 7.5.
- **The gauntlet was not run**, so no SOTA claim is made and Delight is scored
  down rather than held.
- **The 2.5.8 spacing exception is unevaluated**, so the 30.1% figure is an
  upper bound on the target-size defect.
- **The native/author target discrimination is inert on this app.** Tailwind
  preflight sets padding on every control, so the `authorSized` test never
  grants the user-agent-default exception. The affected population is bounded:
  at most ~68 native-kind controls of 4,730 (1.4%), which cannot move the
  headline percentages. Conservative direction — it over-counts author-styled
  targets, never under-counts.
- **Settle timings in this capture overlap a concurrent monorepo typecheck.**
  Median 2,313 ms / p90 3,257 ms here; the uncontended earlier run of the same
  build gave 2,148 ms / 2,690 ms. The perceived-performance score uses the
  slower figure, which is the conservative direction.
- **Reduced-motion was sampled on 10 surfaces, not all 86.**
- **`element-level unreachable clipping` reports 1,475 elements across 78
  surfaces**, but a large constant share is persistent sidebar chrome repeated
  on every board surface, and most overflows are 6–20px. It is reported as a
  count, and deliberately **not** scored, because the per-surface signal cannot
  be separated from the chrome constant without a chrome-subtraction pass that
  this run does not implement.

---

## 6. The one change that matters most

Unchanged from the code audit, and now measured rather than inferred:
**route-level code splitting.** One 6.46 MiB JS chunk gates first paint of text
at a median 2.3 s on loopback with a warm server — the best case this app will
ever see. Every other finding here is a fix inside a component; this one is the
shape of the bundle.
