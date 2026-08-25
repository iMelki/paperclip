# capture.mjs — two gate defects, verified in code

Reported by a peer session (43083044); **independently confirmed here at the line level** before
being written down. Recorded as a note rather than a patch because `capture.mjs` was being
modified by the owning lane 90 seconds before this was written — two writers on one file is the
hazard, not the fix.

Both defects are measurement-validity failures, which is the class that has already cost this
programme a false regression and a false alarm. Neither is cosmetic.

---

## 1. Redirect hole — a surface can be MEASURED while depicting a different surface

**Confirmed.** `redirected` is computed at **line 315** and recorded at **line 415**, but the
outcome decision at **line 403** never consults it:

```js
const outcome = controlFailed ? 'INCONCLUSIVE' : (content.ok ? 'MEASURED' : 'NO-CONTENT');
```

So when `/auth` redirects to `/:companyPrefix/dashboard` under `local_trusted`, the landed
page's main text is long enough and differs from both refs, the fingerprint gate passes, and
`/auth` is labelled **MEASURED** — while actually depicting the dashboard. The peer's report
notes the dry3 run shows exactly this.

Known redirect pairs at this commit: `/auth` → `/:companyPrefix/dashboard`;
`/:companyPrefix/workspaces` → `/issues`; `/apps/connect` → `/apps`; `/projects/:id` → `.../issues`.

**Why it matters beyond the label:** the measured count double-counts one rendered view. A
denominator built from it overstates coverage — the same shape as counting `/` and `/dashboard`
separately on memsys, where earlier rounds captured `/dashboard` twice without noticing.

**Fix:** when `redirected` is true AND `landedPattern` equals another attempted surface's
pattern, record `DUPLICATE-REDIRECT` and exclude it from aggregates. If that is too large a
change, demote to `NO-CONTENT` and state `landedPattern` in the record. Do not leave it MEASURED.

## 2. Outside-`<main>` surfaces are NO-CONTENT'd for a gate reason, not an app reason

**Confirmed.** `MAIN_TEXT` at **lines 232–233** returns `''` when there is no `<main>`:

```js
const m = document.querySelector('main');
return m ? (m.innerText || '').replace(/\s+/g, ' ').trim() : '';
```

Three surfaces render visible content outside `<main>` and will be NO-CONTENT'd:
`/onboarding` ("Name your company"), `/ux-lab/responsible-user-denial`, and
`/ux-lab/cross-issue-collaboration`. The peer's `discovery.json` carries their samples.

**Note the fallback already exists two lines away** — line 199 computes
`document.body.innerText` and does not feed `MAIN_TEXT`.

**Fix:** fall back to visible body text minus `nav`/`aside`/`header`/`[data-sidebar]` when
`main` is empty. **Use `innerText` with visibility walking, never `textContent`** — the hidden
cmdk "Command Palette" dialog text is present in EVERY route's DOM, so a `textContent` gate
passes on every page and is therefore incapable of failing.

If the fallback is not implemented, the three must be reported as a **gate limitation**, never
as app emptiness. "The probe could not see it" and "there is nothing there" are different
findings and must not share an outcome.

---

## Also settled

`126 capturable` is **jointly refuted** — the adapter here (68 static production-reachable, 46
dynamic) agrees with the peer's independent flat derivation (68 production-reachable static).
The honest enumerable-with-seed denominator is **74**. Report 74 and say why.

At 390px the Layout switches to `min-h-dvh overflow-x-clip` with no `h-dvh` shell, so
per-surface detector election matters more there, not less.

**Never capture 127.0.0.1:3199** — it is the operator's real onboarded instance (real companies,
real issue data, a private trading project). All four harness entry points now refuse it with
exit code 2; see the SAFETY GATE block in `capture.mjs`, `discover.mjs`, `runner.mjs` and
`loadcost.mjs`. Use `BASE=http://127.0.0.1:3197` (isolated Northwind seed).

---

# Round 2 — three further findings, INDEPENDENTLY RE-VERIFIED against capture-1440-router-derived.json

Peer session 43083044 reported these from content review. Every one reproduced here from the JSON
itself, not accepted on report. Numbers agree to within one.

| Claim | Peer reported | Verified here |
|---|---|---|
| Clip detector overcounts | 282 of 285 are `overflow:visible` | **285 samples → 282 visible, 1 hidden, 2 clip** |
| Tiny-target false positives | 79 sr-only skip-links, ~1347 real | **1426 under-24 → 80 sr-only, 0 native, 1346 real** |
| Contrast coverage | 8% (738 / 8152) | **738 measured / 8152 skippedNoBg = 8.3%** |
| Redirect hole persists | 13 redirect-MEASURED, 3 duplicate | **13 redirect-MEASURED, 3 depict another attempted surface** |

Top under-24 offenders also reproduce exactly: `a.flex items-center` x525,
`button.absolute -left-4` x159 (then `a.hover:text-foreground` x86, `button.inline-flex` x55).

## 1. `clippedCount` is NOT reportable as damage

`scrollWidth > clientWidth` on `overflow:visible` **paints outside the box — it does not clip**.
Content stays visible and reachable. 99% of the samples are that case. Reporting the 1475
aggregate as clipping would be reporting a non-defect as damage.

Only **3 samples are true hidden/clip**: an input placeholder cut 21px on `/routines/:id`, 224px
on `/execution-workspaces/:id/configuration`, and one span 17px on `/inbox/all`.

**Fix:** count only `overflowX` in `hidden|clip`, plus effective ancestor clipping. **Add a
negative control: an `overflow:visible` twin that must NOT be counted** — without it the detector
cannot be shown to discriminate, and this fleet has already shipped detectors that counted
everything and detectors that counted nothing.

## 2. Skip-links are a WCAG feature, not a target-size failure

80 of the 1426 are `a.sr-only focus:not-sr-only` — 1px only while unfocused, expanding on focus.
Counting them as 2.5.8 failures penalises the app for doing the right thing. **1346 is the honest
number.** 0 are native, so the UA-default exception does not apply here — every one of the 1346 is
author-owned and genuinely fails at AAA/44px.

## 3. CONTRAST IS 8.3% COVERED AND MUST NOT BE REPORTED AS CLEAN

This is the most consequential of the three. Tailwind v4 serialises colours as `oklch()`;
the parser reads only `rgb`/`rgba`, so **~92% of text nodes skip as "no bg"**. The 204 failures
found are real (cm-gutter 2.46, avatars 2.15–2.49) — but they were found in 8.3% of the surface.

**Absence of measurement is not a pass.** That is this programme's own standing rule, and it
applies to us here exactly as it applied to every app we scored. The dimension must be reported
as **8.3%-covered**, never as clean, and it must not earn a score that implies coverage.

**Fix for a re-run:** draw the colour to a 1×1 canvas and read back rgba — simplest reliable
oklch resolution.

## 4. Also: two false NO-CONTENTs

`/approvals/pending` and `/approvals/all` render real empty states ("No pending approvals.")
that fall under `MIN_MAIN_CHARS = 40` (capture.mjs:276). A legitimate empty state is not an
absent surface. Either lower the floor for known-empty-state routes or record them as
`EMPTY-STATE`, distinct from `NO-CONTENT`.

## Distinct-measured

`distinct-measured = 77/86` is the honest figure while the redirect hole stands, and the README
should carry it that way unless a v2 pass demotes the 3 duplicates.
