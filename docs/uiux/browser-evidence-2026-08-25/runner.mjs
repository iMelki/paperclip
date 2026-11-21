/**
 * Paperclip UI capture + measurement runner — FIRST BROWSER CAPTURE.
 *
 * Usage:
 *   BASE=http://127.0.0.1:3197 WIDTH=1440 HEIGHT=900 SHOTS=1 \
 *     node runner.mjs ./capture-1440-all-surfaces.json
 *
 * Outcomes are three, never two:
 *   MEASURED      — settled, content assertion held, every control moved
 *   INCONCLUSIVE  — a control did not move, or the run threw
 *   NO-CONTENT    — the surface settled but its content assertion never
 *                   appeared (a redirect, a gate, or an empty state). These
 *                   are reported and EXCLUDED from every aggregate. They are
 *                   the denominator gap, stated rather than hidden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEASURE, CONTROL_ON, CONTROL_OFF } from './probes.mjs';
import { PREFIX, STATIC_SURFACES, APP_SURFACES, dynamicSurfaces } from './surfaces.mjs';

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
const PW = new URL('../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(PW.href);


const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const SHOTS = process.env.SHOTS === '1';
const OUT = process.argv[2] || './capture.json';
const SHOTDIR = path.join(path.dirname(path.resolve(OUT)), 'shots');

// ---- discover seeded entity ids from the live API (no UUIDs in tracked files)
async function api(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) return null;
  return r.json();
}
const companies = await api('/api/companies');
const company = (companies || []).find((c) => c.issuePrefix === PREFIX) || (companies || [])[0];
if (!company) { console.error('no company; seed first'); process.exit(2); }
const [issues, projects, agents, goals] = await Promise.all([
  api(`/api/companies/${company.id}/issues`),
  api(`/api/companies/${company.id}/projects`),
  api(`/api/companies/${company.id}/agents`),
  api(`/api/companies/${company.id}/goals`)
]);
const pick = (arr, fn) => (Array.isArray(arr) ? arr.find(fn) || arr[0] : null);
const ids = {
  issueId: pick(issues, (i) => /Arm stalls/.test(i.title || ''))?.id,
  projectId: pick(projects, (p) => p.name === 'Kitchen Autonomy')?.id,
  agentId: pick(agents, (a) => a.name === 'Ada Chen')?.id,
  goalId: pick(goals, (g) => /Ship the v3/.test(g.title || ''))?.id
};

const SURFACES = [
  ...STATIC_SURFACES.map((s) => ({ ...s, group: 'static' })),
  ...dynamicSurfaces(ids).map((s) => ({ ...s, group: 'dynamic' })),
  ...APP_SURFACES.map((s) => ({ ...s, group: 'app' }))
];

const urlFor = (s) => BASE + (s.unprefixed ? s.path : `/${PREFIX}${s.path}`);

/**
 * Settle: poll until the DOM stops mutating AND no skeleton/spinner remains.
 * Quiescence alone is not readiness for a client-fetched surface, so the
 * content assertion below is a SEPARATE fact and is what decides the outcome.
 */
const SETTLE = `(() => {
  const skel = document.querySelectorAll(
    '.animate-pulse,[aria-busy="true"],[role="progressbar"],[data-loading="true"],[data-state="loading"]'
  ).length;
  const root = document.getElementById('root');
  // READINESS PRECONDITION, added after the first sweep of this app returned
  // 76/76 surfaces "quiescent at ~770ms" with textLength 0. waitUntil:'commit'
  // hands back an empty <div id="root"></div>; a stability counter that starts
  // on that DOM declares the empty shell settled after three identical polls.
  // Stability is only allowed to accumulate once React has actually mounted
  // something AND painted text. Without this the run measures nothing and
  // every zero is meaningless.
  const mounted = Boolean(root && root.children.length > 0);
  const text = (document.body.innerText || '').trim();
  return {
    html: document.body.innerHTML.length, text: text.length, skel,
    ready: mounted && text.length > 20
  };
})()`;

async function settle(page, maxMs = 25000) {
  const t0 = Date.now();
  let last = null, stable = 0, polls = 0, everReady = false;
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(SETTLE).catch(() => null);
    polls++;
    if (s?.ready) everReady = true;
    if (s && s.ready && last && s.html === last.html && s.text === last.text && s.skel === 0) {
      stable++;
      if (stable >= 3) {
        return { settleMs: Date.now() - t0, mode: 'quiescent', polls, skel: s.skel, ready: true };
      }
    } else {
      stable = 0;
    }
    last = s;
    await page.waitForTimeout(250);
  }
  return {
    settleMs: Date.now() - t0,
    mode: everReady ? 'ceiling-reached' : 'never-mounted',
    polls, skel: last?.skel ?? null, ready: everReady
  };
}

const browser = await chromium.launch();

// ---------------------------------------------------------------------------
// GATE 1: capture the persistent chrome text, then PROVE no `expect` string is
// chrome. A run whose assertions match always-present sidebar text measures the
// skeleton. This check is proven able to fail below.
// ---------------------------------------------------------------------------
const chromeCtx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
const chromePage = await chromeCtx.newPage();
await chromePage.goto(`${BASE}/${PREFIX}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
await settle(chromePage);
const chromeText = await chromePage.evaluate(`(() => {
  const parts = Array.from(document.querySelectorAll('nav, aside, header, [data-sidebar]'))
    .map((n) => n.innerText || '');
  return parts.join(' ').replace(/\\s+/g, ' ');
})()`);
await chromeCtx.close();

function chromeCollisions(list) {
  return list
    .filter((s) => chromeText.toLowerCase().includes(String(s.expect).toLowerCase()))
    .map((s) => `${s.id}:"${s.expect}"`);
}
const collisions = chromeCollisions(SURFACES);
// Negative control: a string that IS chrome must be caught by the same check.
const chromeCheckProvenAbleToFail =
  chromeCollisions([{ id: '__control__', expect: 'Dashboard' }]).length === 1;

// ---------------------------------------------------------------------------
if (SHOTS) fs.mkdirSync(SHOTDIR, { recursive: true });
const results = [];

for (const surface of SURFACES) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 160)));
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });

  let rec = { surface: surface.id, group: surface.group, path: surface.path };
  try {
    const resp = await page.goto(urlFor(surface), { waitUntil: 'commit', timeout: 45000 });
    const st = await settle(page);
    const finalPath = new URL(page.url()).pathname;
    const redirected = finalPath !== new URL(urlFor(surface)).pathname;

    // CONTENT GATE (hardened after the chrome gate flagged 22 vacuous expects):
    // the assertion binds to text OUTSIDE the persistent chrome — <main> when
    // present, else the body with nav/aside/header/[data-sidebar] removed — so
    // a sidebar string can never satisfy a surface's content assertion.
    // CONTENT GATE: visible text that is NOT inside the persistent chrome
    // (nav/aside/header/[data-sidebar]). Visible-only (display/visibility/rect
    // checks) so the hidden command-palette dialog that exists on every route
    // can never satisfy an assertion; chrome-excluded so sidebar text can
    // never satisfy one either — including on surfaces whose <main> is empty
    // (onboarding and the ux-lab pages render outside <main>).
    const nonChromeText = await page.evaluate(`(() => {
      const chrome = Array.from(document.querySelectorAll('nav, aside, header, [data-sidebar]'));
      const inChrome = (el) => { let n = el; while (n) { if (chrome.includes(n)) return true; n = n.parentElement; } return false; };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const parts = []; const cache = new Map(); let node;
      const visible = (el) => {
        if (cache.has(el)) return cache.get(el);
        const cs = getComputedStyle(el);
        let ok = cs.display !== 'none' && cs.visibility !== 'hidden';
        if (ok) { const r = el.getBoundingClientRect(); ok = r.width > 0 && r.height > 0; }
        cache.set(el, ok);
        return ok;
      };
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').trim();
        if (!t) continue;
        const p = node.parentElement;
        if (!p || !visible(p) || inChrome(p)) continue;
        parts.push(t);
      }
      return parts.join(' ');
    })()`);
    const contentSeen = nonChromeText.toLowerCase().includes(String(surface.expect).toLowerCase());

    // main-minus-chrome delta: how much of what we measured is NOT the sidebar
    const contentChars = await page.evaluate(`(() => {
      const m = document.querySelector('main');
      return m ? (m.innerText || '').replace(/\\s+/g, ' ').trim().length : 0;
    })()`);

    const before = await page.evaluate(MEASURE);

    // ---- positive controls, on this page, in this run
    const ctlOn = await page.evaluate(CONTROL_ON);
    await page.waitForTimeout(120);
    const ctlM = await page.evaluate(MEASURE);
    await page.evaluate(CONTROL_OFF);
    await page.waitForTimeout(120);
    const after = await page.evaluate(MEASURE);

    const controls = {
      shellOverflowMoved: ctlOn.shell > before.shellOverflow + 300,
      shellOverflowUnderControl: ctlOn.shell,
      retiredBodyStayedDead: ctlOn.retiredBody <= before.retiredBodyOverflow + 1,
      retiredBodyUnderControl: ctlOn.retiredBody,
      retiredDocStayedDead: ctlOn.retiredDoc <= before.retiredDocOverflow + 1,
      escapeControlSeen: ctlM.escapedCount > before.escapedCount,
      tinyTargetControlSeen: ctlM.targets.some((t) => t.min <= 11 && !t.native),
      textControlSeen: ctlM.minText !== null && ctlM.minText <= 7.5,
      clipControlSeen: ctlM.clippedCount > before.clippedCount,
      clipControlOverflowPx: ctlOn.clipOverflowPx,
      scrollableTwinOverflowPx: ctlOn.scrollableOverflowPx,
      scrollableNotCounted: !ctlM.clippedWorst.some((c) => c.overflowX === 'auto'),
      contrastControlSeen: ctlM.contrast.failCount > before.contrast.failCount,
      contrastHighTwinNotFlagged: !ctlM.contrast.worst.some((f) => /CONTRAST CONTROL HIGH/.test(f.text || '')),
      motionControlSeen: ctlM.motion.animated > before.motion.animated,
      restored:
        Math.abs(after.shellOverflow - before.shellOverflow) < 2 &&
        after.clippedCount === before.clippedCount &&
        after.contrast.failCount === before.contrast.failCount &&
        after.motion.animated === before.motion.animated
    };
    const controlFailed = !(
      controls.shellOverflowMoved && controls.escapeControlSeen &&
      controls.tinyTargetControlSeen && controls.textControlSeen &&
      controls.clipControlSeen && controls.scrollableNotCounted &&
      controls.contrastControlSeen && controls.contrastHighTwinNotFlagged &&
      controls.motionControlSeen && controls.restored
    );

    // ---- prefers-reduced-motion pass on the SAME surface
    let reduced = null;
    try {
      const rctx = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT }, reducedMotion: 'reduce'
      });
      const rp = await rctx.newPage();
      await rp.goto(urlFor(surface), { waitUntil: 'commit', timeout: 45000 });
      await settle(rp);
      const rm = await rp.evaluate(MEASURE);
      reduced = {
        mediaQueryActive: rm.motion.reducedMotionActive,
        animated: rm.motion.animated,
        infinite: rm.motion.infinite,
        transitioned: rm.motion.transitioned
      };
      await rctx.close();
    } catch (e) { reduced = { error: String(e).slice(0, 120) }; }

    const outcome = controlFailed ? 'INCONCLUSIVE' : (contentSeen ? 'MEASURED' : 'NO-CONTENT');

    if (SHOTS && outcome === 'MEASURED') {
      await page.screenshot({
        path: path.join(SHOTDIR, `${surface.id}-${WIDTH}.png`),
        fullPage: false, type: 'png'
      });
    }

    rec = {
      surface: surface.id, group: surface.group, path: surface.path,
      finalPath, redirected,
      httpStatus: resp ? resp.status() : null,
      settleMs: st.settleMs, settleMode: st.mode, settlePolls: st.polls, skeletonsAtSettle: st.skel,
      expect: surface.expect, contentSeen, contentChars,
      controls, controlFailed, outcome,
      reducedMotion: reduced,
      consoleErrors: consoleErrors.slice(0, 6),
      badResponses: Array.from(new Set(bad)).slice(0, 6),
      m: before
    };
  } catch (e) {
    rec = {
      surface: surface.id, group: surface.group, path: surface.path,
      error: String(e).slice(0, 240), controlFailed: true, outcome: 'INCONCLUSIVE'
    };
  }

  results.push(rec);
  const f24 = rec.m ? rec.m.targets.filter((t) => t.min < 24 && !t.native).length : '-';
  const f44 = rec.m ? rec.m.targets.filter((t) => t.min < 44 && !t.native).length : '-';
  console.log(
    `${String(rec.surface).padEnd(22)} ${String(rec.httpStatus).padEnd(4)} ` +
    `s=${String(rec.settleMs).padEnd(6)}${String(rec.settleMode).padEnd(16)} ` +
    `shellOvf=${String(rec.m?.shellOverflow).padEnd(6)} esc=${String(rec.m?.escapedCount).padEnd(4)} ` +
    `clip=${String(rec.m?.clippedCount).padEnd(4)} f24=${String(f24).padEnd(4)} f44=${String(f44).padEnd(4)} ` +
    `ctr=${String(rec.m?.contrast?.failCount).padEnd(4)} anim=${String(rec.m?.motion?.animated).padEnd(4)} ` +
    `[${rec.outcome}]`
  );
  await ctx.close();
}

await browser.close();

const measured = results.filter((r) => r.outcome === 'MEASURED');
const payload = {
  base: BASE,
  viewport: { width: WIDTH, height: HEIGHT },
  capturedAt: new Date().toISOString(),
  companyPrefix: PREFIX,
  denominator: {
    enumeratedSurfaces: SURFACES.length,
    reachedWithContent: measured.length,
    noContent: results.filter((r) => r.outcome === 'NO-CONTENT').map((r) => r.surface),
    inconclusive: results.filter((r) => r.outcome === 'INCONCLUSIVE').map((r) => r.surface)
  },
  chromeGate: {
    chromeTextLength: chromeText.length,
    chromeTextSample: chromeText.slice(0, 220),
    expectStringsCollidingWithChrome: collisions,
    chromeCheckProvenAbleToFail
  },
  results
};
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`\nwrote ${OUT}`);
console.log(`enumerated=${SURFACES.length} measured=${measured.length} ` +
  `no-content=${payload.denominator.noContent.length} inconclusive=${payload.denominator.inconclusive.length}`);
if (collisions.length) console.error(`CHROME COLLISION (assertion is vacuous): ${collisions.join(', ')}`);
if (!chromeCheckProvenAbleToFail) console.error('CHROME CHECK COULD NOT FAIL — gate is inert');
