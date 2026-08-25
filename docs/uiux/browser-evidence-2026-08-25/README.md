# Paperclip UI — first browser capture (2026-08-25)

This directory holds the **first browser-measured evidence** for `paperclip-ui`.
The 2026-08-09 audit (`docs/uiux-awwwards-report-2026-08-09.md`) states its own
mode plainly: *"CODE-ONLY AUDIT. No server was started and no browser evidence
was captured."* That score has been carried for ten fleet rounds. Everything in
this directory was measured in a headless Chromium against a running server, at
a named commit, with the detector proven able to fail on the same page in the
same run.

---

## 1. Why ten rounds produced no capture

The fleet's canonical surface derivation is an **App Router (file-system)**
deriver. Paperclip is not a Next application. It is a Vite SPA whose entire
surface map is a nested `<Route>` JSX tree in `ui/src/App.tsx`. A file-system
deriver pointed at this repo sees `ui/src/pages/*.tsx` — *component files*, not
routes — and emits a surface list that matches no URL the server serves. The
capture step then had nothing valid to visit.

`react-router-adapter.mjs` in this directory is the fix: a React Router
derivation that parses `ui/src/App.tsx` into the real nested tree and emits full
URL paths. Four things in that file are not optional, and each was added because
the naive version got the answer wrong:

1. **A brace/quote-aware tag scanner.** `/<Route[\s\S]*?>/` terminates inside
   `element={<Navigate to="/x" replace />}`, truncating the tag and losing the
   element name — which is what decides `redirect` vs `static`.
2. **Nesting.** Paths are relative to their parent. Without a stack, board
   routes come out as `/dashboard` instead of `/:companyPrefix/dashboard`, and
   every board URL 404s.
3. **Out-of-line fragment splicing.** `boardRoutes()` is a ~150-route fragment
   *defined above* the `<Routes>` tree and mounted under
   `<Route path=":companyPrefix">`. A linear scan attributes it to the wrong
   parent and silently drops the company prefix from every board URL.
4. **DEV gating and template expansion.** Routes inside
   `import.meta.env.DEV ? (...) : null` do not exist in the production bundle
   the server ships; the `agents/${tab}` template route is expanded against the
   real `AGENT_FILTER_TABS` in `ui/src/pages/Agents.tsx`.

Run it standalone: `node react-router-adapter.mjs` (add `LIST=1` to list paths).

---

## 2. Files

| File | What it is |
|---|---|
| `react-router-adapter.mjs` | React Router surface derivation from `ui/src/App.tsx`. Standalone-runnable. |
| `probes.mjs` | In-page measurement (`MEASURE`) and the positive/negative controls (`CONTROL_ON` / `CONTROL_OFF`). |
| `capture.mjs` | The sweep: settle, content assertion, controls, measure, three outcomes, exit 3 on INCONCLUSIVE. |
| `summarize.mjs` | Aggregates a capture JSON into the tables the scorecard cites. |
| `loadcost.mjs` | Cold-load request count and transferred bytes for one surface. |
| `provenance.json` | Server, commit, build-currency and bundle-size facts for the run. |
| `capture-1440-router-derived.json` | The 1440x900 capture (full 86-surface sweep). |
| `capture-390-router-derived.json` | The 390x844 capture (full 86-surface sweep). |
| `capture-1440-dark-router-derived.json` | Bounded dark-mode sample (28 surfaces). |
| `capture-1440-all-surfaces.json` | The FIRST sweep, kept as the record that refuted "quiescence = readiness": 76/76 "settled" at ~770ms with textLength 0. Nothing in it is a measurement. |
| `loadcost-dashboard.json` | Cold-load cost of the board dashboard. |
| `seed.mjs` | Seeds the fictional Northwind Robotics fixture into an ISOLATED instance; refuses instances holding companies it did not create. |
| `shots.mjs` | Curated, content-gated screenshot pass (both widths) for the committed sample. |
| `SCORECARD.md` | What the numbers mean, and the re-score against the fleet rubric. |
| `GATE-DEFECTS-VERIFIED.md` | Independently verified measurement-validity caveats for reading the capture JSONs (redirect hole, clip overcount, sr-only targets, 8.3% contrast coverage). Read it before citing aggregates. |
| `derive-routes.mjs`, `discover.mjs`, `discovery.json`, `runner.mjs`, `surfaces.mjs` | The predecessor discovery-based harness (expect-string assertions per surface), kept for the record; superseded by `capture.mjs` + the router adapter. |
| `shots/` | The curated screenshot sample (content-gated; never a skeleton). |

---

## 3. How to reproduce

```
# 1. a paperclip server on an isolated, fictional-seed instance (see 4 below)
# 2. then:
node react-router-adapter.mjs                       # the denominator
BASE=http://127.0.0.1:3197 node capture.mjs out.json # the capture
node summarize.mjs out.json                          # the tables
```

Exit codes are the third outcome, not decoration:

- `0` — every attempted surface reached MEASURED or NO-CONTENT.
- `2` — fatal: no company on the instance, so no board URL can be built.
- `3` — at least one surface is INCONCLUSIVE, **or** the content gate could not
  be proven able to fail. Either way nothing in the run should be scored.

---

## 4. Data safety — read this before re-running

`capture.mjs` and `loadcost.mjs` **refuse** to run against
`127.0.0.1:3199`. That port carries a real onboarded instance with real operator
content. This directory is in a **public** repository, so a capture pointed at
it would write operator data into tracked evidence.

The captures here were taken against an isolated instance seeded with a
fictional company. Two independent safeguards are in place and both are
deliberate:

- the port gate above, which refuses rather than defaulting, so the mistake
  cannot be made silently; and
- `redact()` in `capture.mjs`, which reduces **every** human-readable string in
  the output to `{len, sha8}`. Tag names and CSS class names are kept — they are
  source code and already public in this repo — and they are what a fix needs in
  order to locate a failing element. Entity ids resolved from the live API are
  used to build URLs and are never written out; dynamic surfaces are reported
  under their `:param` pattern.

Redaction costs some analytic detail (you cannot read the text of a
contrast-failing node, only its tag, class, computed colours and ratio). That
trade was taken on purpose: the bundle stays safe even if a future run is
pointed somewhere else.

---

## 5. Detector doctrine — what the control refuted

Three separate detector premises were tested against a control on the actual
pages, and two of them were wrong.

**Refuted: "quiescence means the page is ready."** A stability counter that
starts on `<div id="root"></div>` declares this app settled in about 770 ms with
`textLength: 0`, and every subsequent measurement is a zero. React does not mount
here until roughly 3–7 seconds after `commit`. The prior sweep in this directory
returned 76 of 76 surfaces "quiescent at ~770 ms" and measured nothing —
including a body font of `"Times New Roman"`, i.e. before the stylesheet applied.
Stability is now only allowed to accumulate once React has mounted **and**
painted text.

**Refuted: "the shell clip container is the live overflow detector, and
`document.body` / `documentElement` are dead."** That holds on **board** surfaces
— `<Layout>` sets `overflow-clip`, so a 2500 px control inside `<main>` leaves
body at 0. It is **false** on standalone surfaces (`/auth`, the ux-labs, the dev
perf harness), where the identical control moves `document.body` instead and
leaves the shell at 0. Hard-coding either one reports `0px overflow` across half
the app and reads as clean.

**Refuted a second time: any single detector.** On board surfaces `<main>` is
itself a horizontal scroll container, so the control grows `main.scrollWidth`
and moves *nothing else* — no clip ancestor grows, and the viewport-escape probe
correctly ignores anything inside a scrollable ancestor. With only the first two
premises the board dashboard came back INCONCLUSIVE: "no detector moved".

**What the harness does instead.** The overflow detector is **elected per surface
by the control**: inject 2500 px, observe which of `{shell clip container,
main.scrollWidth, document.body, documentElement}` actually absorbed it, and use
that one. If none moves, no overflow statement about that surface is
trustworthy and the surface is INCONCLUSIVE rather than "0 px, clean". Which
detector won on each surface is recorded in the capture JSON
(`results[].overflowDetector`) so the reader can see the choice rather than
trust it.

**Controls, per surface, in the same run.** Positive: overflow (elected as
above), tiny target, tiny text, unreachable clipping, contrast, motion.
Negative: a scrollable twin with identical overflow must **not** be counted as
clipped; a 21:1 contrast twin must **not** be flagged; every injected control is
removed and all detectors must return to baseline. The content gate is proven
able to fail by running it against the app's own 404 surface, captured live in
the same run rather than hard-coded.

---

## 6. What "capturable" means here

Not every `<Route>` is a surface a capture can visit, and the difference is
where earlier surface counts diverge. The adapter classifies and counts them
separately so the denominator is auditable rather than quoted:

- **static** — a concrete path; capturable with no seeded data.
- **dynamic** — contains a `:param`; capturable only for the entities a given
  instance actually holds. The runner resolves ids from the live API at run time
  and reports which patterns it could not reach.
- **redirect** — `<Navigate>` or a `*Redirect` component. Never a surface.
- **splat** / **layout** — a prefix or a wrapper, not a destination.

The honest denominator for a capture run is therefore *static + the dynamic
patterns this instance can reach*, with the unreachable dynamic patterns listed
by name. Both numbers are in `capture-*.json` under `routerDerivation`.
