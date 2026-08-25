/**
 * Paperclip UI browser capture — surfaces derived from the REAL router.
 *
 *   BASE=http://127.0.0.1:3197 WIDTH=1440 node capture.mjs out.json
 *
 * THREE OUTCOMES, never two, and the exit code carries the third:
 *   MEASURED     — settled, mounted, content assertion held, EVERY positive
 *                  control moved on THIS page in THIS run.
 *   NO-CONTENT   — settled and mounted but the surface rendered a redirect, a
 *                  feature gate, or an empty state. Reported and EXCLUDED from
 *                  every aggregate: it is the denominator gap, stated.
 *   INCONCLUSIVE — a control did not move, or the run threw. Nothing measured
 *                  here is trustworthy. Exit code 3.
 *
 * PRIVACY. paperclip is a PUBLIC repository and the instance under test holds
 * the operator's real boards. Every string this file writes to the output JSON
 * is passed through `redact()`, which keeps only a length and a truncated
 * SHA-256. Lengths and hashes are enough to prove two surfaces differ (the
 * content assertion) and enough to reproduce a comparison, and they carry no
 * readable content. Class names and tag names are kept: they are source code,
 * already public in this repo. Entity ids resolved from the live API are used
 * to build URLs but are never written out — dynamic surfaces are reported
 * under their :param pattern.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEASURE, CONTROL_ON, CONTROL_OFF } from './probes.mjs';
import { deriveRoutes, toUrl } from './react-router-adapter.mjs';

// SAFETY GATE (cross-session data-safety warning, 2026-08-25):
// 127.0.0.1:3199 is the operator's REAL onboarded paperclip instance (real companies,
// real issue data, including a private trading project). Capturing it writes real
// operator data into TRACKED evidence. The isolated fictional-seed instance is :3197.
// This REFUSES rather than defaults, so the mistake cannot be made silently.
const __base = process.env.BASE || "http://127.0.0.1:3197";
if (/:3199(?![0-9])/.test(__base) && process.env.ALLOW_REAL_INSTANCE !== "i-understand-this-is-real-operator-data") {
  console.error("REFUSED: " + __base + " is the operator real instance. Use BASE=http://127.0.0.1:3197 (isolated Northwind seed).");
  process.exit(2);
}
const BASE = __base;
const PW = 'S:/source/CCAI/Assistants/tools/paperclip/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';
const { chromium } = await import(`file://${PW}`);


const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const OUT = process.argv[2] || './capture.json';
const SHOTDIR = process.env.SHOTDIR || '';
// Screenshots are committed only from the fictional-seed instance, and only a
// bounded sample: 87 full-viewport PNGs would add ~25 MB to a public repo for
// no extra proof. The cap is stated in the output so the sample is not mistaken
// for the population.
const SHOT_MAX = Number(process.env.SHOT_MAX || 0);
let shotsTaken = 0;
const MOTION_SAMPLE = Number(process.env.MOTION_SAMPLE || 10);
const SETTLE_CEILING = Number(process.env.SETTLE_CEILING || 20000);

const redact = (s) => {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return { len: str.length, sha8: crypto.createHash('sha256').update(str).digest('hex').slice(0, 8) };
};
const fingerprint = (s) =>
  crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** Strip every human-readable string out of a MEASURE payload. */
function redactMeasure(m) {
  if (!m) return m;
  const c = JSON.parse(JSON.stringify(m));
  for (const t of c.targets || []) t.text = redact(t.text);
  for (const e of c.escapedWorst || []) e.text = redact(e.text);
  for (const u of c.under12Sample || []) u.text = redact(u.text);
  for (const k of c.clippedWorst || []) k.text = redact(k.text);
  for (const f of (c.contrast && c.contrast.worst) || []) f.text = redact(f.text);
  for (const s of (c.motion && c.motion.samples) || []) if (s.text) s.text = redact(s.text);
  if (c.typography) {
    c.typography.h1Text = redact(c.typography.h1Text);
    for (const h of c.typography.headings || []) h.text = redact(h.text);
  }
  c.title = redact(c.title);
  return c;
}

// --------------------------------------------------------------------------
// 1. Derive surfaces from the router (not from the filesystem, not from a
//    number carried between rounds).
// --------------------------------------------------------------------------
const derived = deriveRoutes();

async function api(p) {
  try {
    const r = await fetch(BASE + p);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const companies = await api('/api/companies');
if (!Array.isArray(companies) || companies.length === 0) {
  console.error('FATAL: no company on the instance; cannot build board URLs');
  process.exit(2);
}
const wanted = process.env.COMPANY_PREFIX;
const company =
  (wanted && companies.find((c) => c.issuePrefix === wanted)) ||
  companies.slice().sort((a, b) => (b.issueCounter || 0) - (a.issueCounter || 0))[0];
const PREFIX = company.issuePrefix;

const [issues, projects, agents, goals, routines, skills, environments, execWs, approvals] =
  await Promise.all([
    api(`/api/companies/${company.id}/issues`),
    api(`/api/companies/${company.id}/projects`),
    api(`/api/companies/${company.id}/agents`),
    api(`/api/companies/${company.id}/goals`),
    api(`/api/companies/${company.id}/routines`),
    api(`/api/companies/${company.id}/skills`),
    api(`/api/companies/${company.id}/environments`),
    api(`/api/companies/${company.id}/execution-workspaces`),
    api(`/api/companies/${company.id}/approvals`)
  ]);
const first = (a) => (Array.isArray(a) && a.length ? a[0] : null);
const PARAMS = {};
if (first(issues)) PARAMS.issueId = first(issues).id;
if (first(projects)) PARAMS.projectId = first(projects).id;
if (first(agents)) PARAMS.agentId = first(agents).id;
if (first(goals)) PARAMS.goalId = first(goals).id;
if (first(routines)) PARAMS.routineId = first(routines).id;
if (first(skills)) PARAMS.skillId = first(skills).id ?? first(skills).slug;
if (first(environments)) PARAMS.environmentId = first(environments).id;
if (first(approvals)) PARAMS.approvalId = first(approvals).id;
// workspaceId is TWO different entities in this router: an execution workspace
// under /execution-workspaces/:workspaceId, and a project workspace under
// /projects/:projectId/workspaces/:workspaceId. Feeding one id to both routes
// manufactures a false NO-CONTENT, so the id is chosen per pattern.
const execWorkspaceId = first(execWs)?.id ?? null;
const projectWorkspaceId = first(issues)?.projectWorkspaceId ?? null;
const paramFor = (pattern, name) => {
  if (name === 'workspaceId') {
    return pattern.includes('/execution-workspaces/') ? execWorkspaceId : projectWorkspaceId;
  }
  return PARAMS[name] ?? null;
};
const paramsResolved = Object.keys(PARAMS).sort()
  .concat(execWorkspaceId ? ['workspaceId(execution)'] : [])
  .concat(projectWorkspaceId ? ['workspaceId(project)'] : []);

function neededParams(full) {
  return Array.from(new Set((full.match(/:[A-Za-z][A-Za-z0-9]*/g) || [])))
    .map((s) => s.slice(1))
    .filter((n) => n !== 'companyPrefix');
}

const staticSurfaces = derived.capturableStatic.map((r) => ({
  id: r.full,
  kind: 'static',
  pattern: r.full,
  element: r.element,
  url: toUrl(r.full, PREFIX)
}));

const dynamicSurfaces = [];
const dynamicUnresolved = [];
for (const r of derived.dynamic) {
  const need = neededParams(r.full);
  const resolved = {};
  const missing = [];
  for (const n of need) {
    const v = paramFor(r.full, n);
    if (v) resolved[n] = v; else missing.push(n);
  }
  if (missing.length === 0) {
    dynamicSurfaces.push({
      id: r.full, kind: 'dynamic', pattern: r.full, element: r.element,
      url: toUrl(r.full, PREFIX, resolved)
    });
  } else {
    dynamicUnresolved.push({ pattern: r.full, missing });
  }
}

const LIMIT = Number(process.env.LIMIT || 0);
const ALL_SURFACES = [...staticSurfaces, ...dynamicSurfaces];
const SURFACES = LIMIT > 0 ? ALL_SURFACES.slice(0, LIMIT) : ALL_SURFACES;
// Patterns this run will visit, used to tell 'redirected onto another
// surface we are already counting' apart from 'slug canonicalisation'.
const attemptedPatterns = new Set(SURFACES.map((s) => s.pattern));

// --------------------------------------------------------------------------
// 2. Settle: quiescence is NOT readiness. React mounts this app roughly seven
//    seconds after `commit` on a cold context; a stability counter that starts
//    on the empty <div id="root"> declares the shell settled in under a second
//    and every subsequent measurement is a zero. Stability may only accumulate
//    once React has mounted AND painted text.
// --------------------------------------------------------------------------
const SETTLE = `(() => {
  const skel = document.querySelectorAll(
    '.animate-pulse,[aria-busy="true"],[role="progressbar"],[data-loading="true"],[data-state="loading"]'
  ).length;
  const root = document.getElementById('root');
  const main = document.querySelector('main');
  const text = (document.body.innerText || '').trim();
  return {
    html: document.body.innerHTML.length,
    text: text.length,
    mainLen: main ? (main.innerText || '').trim().length : -1,
    skel,
    mounted: Boolean(root && root.children.length > 0),
    ready: Boolean(root && root.children.length > 0) && text.length > 20
  };
})()`;

async function settle(page, maxMs = SETTLE_CEILING) {
  const t0 = Date.now();
  let last = null, stable = 0, polls = 0, everReady = false;
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(SETTLE).catch(() => null);
    polls++;
    if (s && s.ready) everReady = true;
    if (s && s.ready && last && s.html === last.html && s.text === last.text && s.skel === 0) {
      stable++;
      if (stable >= 3) return { settleMs: Date.now() - t0, mode: 'quiescent', polls, skel: s.skel, ready: true, mainLen: s.mainLen };
    } else stable = 0;
    last = s;
    await page.waitForTimeout(250);
  }
  return {
    settleMs: Date.now() - t0,
    mode: everReady ? 'ceiling-reached' : 'never-mounted',
    polls, skel: last?.skel ?? null, ready: everReady, mainLen: last?.mainLen ?? -1
  };
}

// Content is read from <main> where the app provides one, and from the app root
// where it does not. Returning '' for a missing <main> attributes a HARNESS
// limitation to the APP: /ux-lab/* and /onboarding render real content with no
// <main> landmark, and the earlier version recorded them as NO-CONTENT, i.e.
// "the app rendered nothing" when the truth was "this probe looked in the wrong
// box". The absence of the landmark is itself worth reporting, so it is
// reported as `contentRoot`, not silently papered over.
const MAIN_TEXT = `(() => {
  const m = document.querySelector('main') || document.getElementById('root');
  const text = m ? (m.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  return { text, contentRoot: document.querySelector('main') ? 'main' : (m ? 'root' : 'none') };
})()`;

const browser = await chromium.launch();

// The app is dark-mode-first (Storybook's default theme is dark) but headless
// Chromium reports prefers-color-scheme: light, so an unset sweep measures the
// LIGHT theme. Rubric 1.5 asks for contrast in BOTH themes, so the scheme is an
// explicit parameter and is recorded in the output rather than inherited.
const COLOR_SCHEME = process.env.COLOR_SCHEME || 'light';

async function open(url, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT }, colorScheme: COLOR_SCHEME, ...opts
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

// --------------------------------------------------------------------------
// 3. NEGATIVE REFERENCES, measured in this run, on this build.
//    The content assertion is "main rendered something that is neither the
//    404 surface nor the no-company empty state". Both references are captured
//    live rather than hard-coded, and the assertion is then PROVEN ABLE TO
//    FAIL by running it against the 404 reference itself.
// --------------------------------------------------------------------------
const NOT_FOUND_PATH = `/${PREFIX}/__capture_control_route_does_not_exist__`;
const BOGUS_PREFIX_PATH = '/ZZQ/dashboard';

async function reference(urlPath) {
  const { ctx, page } = await open();
  await page.goto(BASE + urlPath, { waitUntil: 'commit', timeout: 45000 });
  const st = await settle(page);
  const probe = await page.evaluate(MAIN_TEXT);
  await ctx.close();
  return { path: urlPath, settleMs: st.settleMs, mode: st.mode, chars: probe.text.length, fp: fingerprint(probe.text), contentRoot: probe.contentRoot };
}

const refNotFound = await reference(NOT_FOUND_PATH);
const refEmptyCompany = await reference(BOGUS_PREFIX_PATH);
console.log(`ref 404      chars=${refNotFound.chars} fp=${refNotFound.fp} (${refNotFound.mode})`);
console.log(`ref no-company chars=${refEmptyCompany.chars} fp=${refEmptyCompany.fp} (${refEmptyCompany.mode})`);

const MIN_MAIN_CHARS = 40;
function assertContent(text) {
  const fp = fingerprint(text);
  return {
    chars: text.length,
    fp,
    longEnough: text.length >= MIN_MAIN_CHARS,
    notNotFound: fp !== refNotFound.fp,
    notEmptyCompany: fp !== refEmptyCompany.fp,
    ok: text.length >= MIN_MAIN_CHARS && fp !== refNotFound.fp && fp !== refEmptyCompany.fp
  };
}

// The gate must be able to say NO. Run it on the 404 reference text itself.
const contentGateProvenAbleToFail = (async () => {
  const { ctx, page } = await open();
  await page.goto(BASE + NOT_FOUND_PATH, { waitUntil: 'commit', timeout: 45000 });
  await settle(page);
  const t = await page.evaluate(MAIN_TEXT);
  await ctx.close();
  return assertContent(t.text).ok === false;
})();
const gateProven = await contentGateProvenAbleToFail;
console.log('content gate proven able to fail:', gateProven);

// --------------------------------------------------------------------------
// 4. Sweep.
// --------------------------------------------------------------------------
if (SHOTDIR) fs.mkdirSync(SHOTDIR, { recursive: true });
const results = [];
let idx = 0;
for (const surface of SURFACES) {
  idx++;
  const { ctx, page } = await open();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 160)));
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`); });

  let rec;
  try {
    const resp = await page.goto(BASE + surface.url, { waitUntil: 'commit', timeout: 45000 });
    const st = await settle(page);
    const landedPattern = new URL(page.url()).pathname
      .split('/' + PREFIX + '/').join('/:companyPrefix/')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');
    const redirected = new URL(page.url()).pathname !== surface.url;

    const mainProbe = await page.evaluate(MAIN_TEXT);
    const content = assertContent(mainProbe.text);
    content.contentRoot = mainProbe.contentRoot;

    const before = await page.evaluate(MEASURE);
    const ctlOn = await page.evaluate(CONTROL_ON);
    await page.waitForTimeout(140);
    const ctlM = await page.evaluate(MEASURE);
    await page.evaluate(CONTROL_OFF);
    await page.waitForTimeout(140);
    const after = await page.evaluate(MEASURE);

    // ---- OVERFLOW DETECTOR: CHOSEN BY THE CONTROL, NOT ASSUMED -----------
    // The prior harness hard-coded "the shell clip container is the live
    // detector, document/body are retired". The control refutes that as a
    // global rule: it holds on BOARD surfaces (inside <Layout>, which sets
    // overflow-clip) and is FALSE on standalone surfaces (/auth, the ux-labs,
    // the dev perf harness), where the very same injected element moves
    // document.body instead and leaves the shell at zero. Assuming either one
    // globally reports 0px overflow on half the app and calls it clean.
    //
    // So the detector is elected per surface by the control: inject, see which
    // container actually absorbed 2500px, and use that one. If NOTHING moves,
    // no overflow statement about this surface is trustworthy -> INCONCLUSIVE.
    const deltas = {
      shell: ctlOn.shell - before.shellOverflow,
      mainScroll: ctlOn.mainScroll - before.mainOverflow,
      body: ctlOn.retiredBody - before.retiredBodyOverflow,
      doc: ctlOn.retiredDoc - before.retiredDocOverflow
    };
    const escapeDelta = ctlM.escapedCount - before.escapedCount;
    const bestName = Object.keys(deltas).sort((a, b) => deltas[b] - deltas[a])[0];
    const overflowProven = deltas[bestName] > 300 || escapeDelta > 0;
    const liveOverflowValue = {
      shell: before.shellOverflow, mainScroll: before.mainOverflow,
      body: before.retiredBodyOverflow, doc: before.retiredDocOverflow
    }[bestName];

    const controls = {
      controlAnchor: ctlOn.anchor,
      overflowDeltas: deltas,
      escapeDelta,
      overflowDetectorElected: overflowProven ? bestName : null,
      overflowFamilyProven: overflowProven,
      tinyTargetControlSeen: ctlM.targets.some((t) => t.min <= 11 && !t.native),
      textControlSeen: ctlM.minText !== null && ctlM.minText <= 7.5,
      clipControlSeen: ctlM.clippedCount > before.clippedCount,
      scrollableNotCounted: !ctlM.clippedWorst.some((c) => c.overflowX === 'auto'),
      contrastControlSeen: ctlM.contrast.failCount > before.contrast.failCount,
      contrastHighTwinNotFlagged: false, // set below, after the object exists
      motionControlSeen: ctlM.motion.animated > before.motion.animated,
      restored:
        Math.abs(after.shellOverflow - before.shellOverflow) < 2 &&
        Math.abs(after.mainOverflow - before.mainOverflow) < 2 &&
        Math.abs(after.retiredBodyOverflow - before.retiredBodyOverflow) < 2 &&
        Math.abs(after.retiredDocOverflow - before.retiredDocOverflow) < 2 &&
        after.clippedCount === before.clippedCount &&
        after.contrast.failCount === before.contrast.failCount &&
        after.motion.animated === before.motion.animated
    };
    // negative twin: the high-contrast control element must NOT be flagged
    controls.contrastHighTwinNotFlagged = !ctlM.contrast.worst.some(
      (f) => String(f.text || '').includes('CONTRAST CONTROL HIGH')
    );

    const universalOk =
      controls.tinyTargetControlSeen && controls.textControlSeen &&
      controls.clipControlSeen && controls.scrollableNotCounted && controls.contrastControlSeen &&
      controls.contrastHighTwinNotFlagged && controls.motionControlSeen && controls.restored;
    const controlFailed = !(controls.overflowFamilyProven && universalOk);
    controls.universalProven = universalOk;

    let reduced = null;
    if (idx <= MOTION_SAMPLE) {
      try {
        const r = await open(null, { reducedMotion: 'reduce' });
        await r.page.goto(BASE + surface.url, { waitUntil: 'commit', timeout: 45000 });
        await settle(r.page);
        const rm = await r.page.evaluate(MEASURE);
        reduced = {
          mediaQueryActive: rm.motion.reducedMotionActive,
          animated: rm.motion.animated, infinite: rm.motion.infinite, transitioned: rm.motion.transitioned
        };
        await r.ctx.close();
      } catch (e) { reduced = { error: String(e).slice(0, 120) }; }
    }

    // A redirected surface is not necessarily its own measurement: /auth
    // redirects onto the board dashboard under local_trusted, passes the
    // content gate on the DASHBOARD's text, and would be counted as a second
    // MEASURED surface depicting a view already counted. Slug canonicalisation
    // (:projectId -> kitchen-autonomy) is NOT that case, so the test is whether
    // the landed pattern belongs to a DIFFERENT attempted surface.
    const landedElsewhere =
      redirected && attemptedPatterns.has(landedPattern) && landedPattern !== surface.pattern;
    const outcome = controlFailed
      ? 'INCONCLUSIVE'
      : (landedElsewhere ? 'DUPLICATE-REDIRECT' : (content.ok ? 'MEASURED' : 'NO-CONTENT'));

    if (SHOTDIR && outcome === 'MEASURED' && (SHOT_MAX === 0 || shotsTaken < SHOT_MAX)) {
      shotsTaken++;
      await page.screenshot({
        path: path.join(SHOTDIR, surface.id.replace(/[^A-Za-z0-9]+/g, '_') + `-${WIDTH}.png`),
        fullPage: false, type: 'png'
      });
    }

    rec = {
      surface: surface.id, kind: surface.kind, element: surface.element,
      pattern: surface.pattern, landedPattern, redirected,
      httpStatus: resp ? resp.status() : null,
      settleMs: st.settleMs, settleMode: st.mode, settlePolls: st.polls, skeletonsAtSettle: st.skel,
      content, controls, controlFailed, outcome,
      overflowDetector: controls.overflowDetectorElected,
      overflowPx: overflowProven ? liveOverflowValue : null,
      hasMainLandmark: Boolean(before.hasMain),
      reducedMotion: reduced,
      consoleErrors: consoleErrors.slice(0, 6).map(redact),
      consoleErrorCount: consoleErrors.length,
      badResponses: Array.from(new Set(bad)).slice(0, 6),
      m: redactMeasure(before)
    };
  } catch (e) {
    rec = {
      surface: surface.id, kind: surface.kind, pattern: surface.pattern,
      error: String(e).slice(0, 200), controlFailed: true, outcome: 'INCONCLUSIVE'
    };
  }
  results.push(rec);
  const f24 = rec.m ? rec.m.targets.filter((t) => t.min < 24 && !t.native).length : '-';
  const f44 = rec.m ? rec.m.targets.filter((t) => t.min < 44 && !t.native).length : '-';
  console.log(
    `${String(idx).padStart(3)}/${SURFACES.length} ${String(rec.surface).padEnd(52)} ` +
    `s=${String(rec.settleMs).padEnd(6)}${String(rec.settleMode).padEnd(15)} ` +
    `main=${String(rec.content?.chars).padEnd(6)} ovf=${String(rec.overflowPx).padEnd(5)}@${String(rec.overflowDetector).padEnd(5)} ` +
    `esc=${String(rec.m?.escapedCount).padEnd(3)} clip=${String(rec.m?.clippedCount).padEnd(3)} ` +
    `t24=${String(f24).padEnd(3)} t44=${String(f44).padEnd(4)} ctr=${String(rec.m?.contrast?.failCount).padEnd(4)} ` +
    `[${rec.outcome}]`
  );
  await ctx.close();
}
await browser.close();

const measured = results.filter((r) => r.outcome === 'MEASURED');
const noContent = results.filter((r) => r.outcome === 'NO-CONTENT');
const inconclusive = results.filter((r) => r.outcome === 'INCONCLUSIVE');
const duplicateRedirect = results.filter((r) => r.outcome === 'DUPLICATE-REDIRECT');

const payload = {
  base: BASE,
  viewport: { width: WIDTH, height: HEIGHT },
  colorScheme: COLOR_SCHEME,
  capturedAt: new Date().toISOString(),
  buildCommit: process.env.BUILD_COMMIT || null,
  companyPrefixRedacted: redact(PREFIX),
  routerDerivation: {
    source: 'ui/src/App.tsx via react-router-adapter.mjs',
    routeRecords: derived.routes.length,
    classification: derived.counts,
    agentFilterTabs: derived.agentFilterTabs,
    capturableStatic: derived.capturableStatic.length,
    distinctDynamicPatterns: derived.dynamic.length,
    dynamicResolvedByLiveApi: dynamicSurfaces.length,
    dynamicUnresolved: dynamicUnresolved.length,
    dynamicUnresolvedPatterns: dynamicUnresolved,
    paramsResolvedFromApi: paramsResolved
  },
  denominator: {
    attempted: SURFACES.length,
    measured: measured.length,
    noContent: noContent.map((r) => r.surface),
    inconclusive: inconclusive.map((r) => r.surface),
    duplicateRedirect: duplicateRedirect.map((r) => ({ surface: r.surface, landedPattern: r.landedPattern })),
    distinctRenderedViews: new Set(measured.map((r) => r.landedPattern)).size
  },
  detector: {
    contentGateProvenAbleToFail: gateProven,
    notFoundReference: { chars: refNotFound.chars, fp: refNotFound.fp, mode: refNotFound.mode },
    noCompanyReference: { chars: refEmptyCompany.chars, fp: refEmptyCompany.fp, mode: refEmptyCompany.mode },
    minMainChars: MIN_MAIN_CHARS,
    positiveControlsPerSurface: [
      'overflowFamilyProven (detector elected per surface, not assumed)',
      'tinyTargetControlSeen', 'textControlSeen', 'clipControlSeen',
      'contrastControlSeen', 'motionControlSeen'
    ],
    negativeControlsPerSurface: [
      'scrollableNotCounted (a scrollable twin with identical overflow must NOT be counted)',
      'contrastHighTwinNotFlagged (a 21:1 twin must NOT be flagged)',
      'restored (every injected control removed; all detectors back to baseline)'
    ],
    motionSampleSize: Math.min(MOTION_SAMPLE, SURFACES.length),
    screenshotsTaken: shotsTaken,
    screenshotCap: SHOT_MAX || null
  },
  results
};

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`\nwrote ${OUT}`);
console.log(`attempted=${SURFACES.length} MEASURED=${measured.length} NO-CONTENT=${noContent.length} INCONCLUSIVE=${inconclusive.length}`);
if (!gateProven) {
  console.error('CONTENT GATE COULD NOT FAIL - the run is inert');
  process.exit(3);
}
if (inconclusive.length) {
  console.error(`INCONCLUSIVE surfaces: ${inconclusive.length}`);
  process.exit(3);
}
process.exit(0);
