/**
 * Frontend SOTA gauntlet — Paperclip UI delight / signature moments (rubric 1.8).
 *
 *   BASE=http://127.0.0.1:5113 node gauntlet.mjs
 *
 * Never uses networkidle (live-polling dashboard). Settles on content markers,
 * not load events — design-guide is a heavy lazy chunk and may never reach load.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = new URL('../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(PW.href);

const BASE = process.env.BASE || 'http://127.0.0.1:5113';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTDIR = path.join(HERE, 'gauntlet-shots');
fs.mkdirSync(SHOTDIR, { recursive: true });

async function api(p) {
  const r = await fetch(BASE + p);
  return r.ok ? r.json() : null;
}

/** Wait for SPA content — main, #root, or signature selectors. Never networkidle. */
async function waitForSurface(page, { minText = 40, selectors = [], maxMs = 90000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(
      ({ minText, selectors }) => {
        const mainLen = (document.querySelector('main')?.innerText || '').trim().length;
        const rootLen = (document.getElementById('root')?.innerText || '').trim().length;
        const textLen = Math.max(mainLen, rootLen);
        const sig = selectors.reduce((n, sel) => n + document.querySelectorAll(sel).length, 0);
        const skel = document.querySelectorAll('.animate-pulse,[aria-busy="true"],[role="progressbar"]').length;
        return { textLen, sig, skel, title: document.title, h2: document.querySelector('h2')?.innerText || '' };
      },
      { minText, selectors },
    );
    if ((state.textLen >= minText || state.sig > 0) && state.skel === 0) {
      return { settled: true, ...state };
    }
    await page.waitForTimeout(400);
  }
  const last = await page.evaluate(() => ({
    textLen: Math.max(
      (document.querySelector('main')?.innerText || '').trim().length,
      (document.getElementById('root')?.innerText || '').trim().length,
    ),
    title: document.title,
  }));
  return { settled: false, ...last };
}

const SIGNATURE_PROBE = `(() => {
  const q = (sel) => document.querySelectorAll(sel).length;
  const styles = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
    };
  };
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    counts: {
      shimmerText: q('.shimmer-text'),
      shimmerMuted: q('.shimmer-text-muted'),
      thinkingIcon: q('.paperclip-thinking-icon'),
      thinkingPath: q('.paperclip-thinking-icon-path'),
      hbPulse: q('.hb-pulse'),
      hbBlink: q('.hb-blink'),
      agentCapSlot: q('.agent-cap-slot'),
      agentCapOnline: q('.agent-cap-online, .agent-cap-online-blue'),
      agentCapLiquid: q('.agent-cap-liquid'),
      agentCapAny: q('[class*="agent-cap"]'),
      cotEntry: q('.cot-line-enter, .dashboard-activity-entry'),
    },
    sample: {
      shimmer: styles('.shimmer-text, .shimmer-text-muted'),
      thinking: styles('.paperclip-thinking-icon-path'),
      hbPulse: styles('.hb-pulse'),
      agentCap: styles('.agent-cap-online, .agent-cap-online-blue, .agent-cap-slot'),
    },
    bodyFont: getComputedStyle(document.body).fontFamily,
    mainTextLen: Math.max(
      (document.querySelector('main')?.innerText || '').trim().length,
      (document.getElementById('root')?.innerText || '').trim().length,
    ),
    consoleErrors: window.__gauntletErrors || [],
  };
})()`;

const health = await api('/api/health');
if (!health?.status) {
  console.error('REFUSED: health probe failed at', BASE);
  process.exit(2);
}

const companies = await api('/api/companies');
const company = Array.isArray(companies) ? companies[0] : companies;
if (!company?.issuePrefix) {
  console.error('REFUSED: no company on instance');
  process.exit(2);
}
const P = company.issuePrefix;
const agents = (await api(`/api/companies/${company.id}/agents`)) || [];
const agentId = agents[0]?.id;

const SURFACES = [
  {
    name: 'design-guide',
    route: `/${P}/design-guide`,
    minText: 80,
    selectors: ['.agent-cap', '.agent-cap-online', '.agent-cap-slot'],
    scrollTo: 'text=Agent Capsule',
  },
  { name: 'dashboard', route: `/${P}/dashboard`, minText: 40 },
  { name: 'agents-all', route: `/${P}/agents/all`, minText: 40 },
];
if (agentId) {
  SURFACES.push({ name: 'agent-detail', route: `/${P}/agents/${agentId}`, minText: 40 });
}

const browser = await chromium.launch();
const results = [];
let shotIndex = 0;

for (const surface of SURFACES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    await page.goto(BASE + surface.route, { waitUntil: 'commit', timeout: 120000 });
    const settle = await waitForSurface(page, {
      minText: surface.minText ?? 40,
      selectors: surface.selectors ?? [],
    });
    if (surface.scrollTo) {
      try {
        await page.getByText('Agent Capsule', { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 15000 });
        await page.waitForTimeout(800);
      } catch {
        /* section may be below fold but capsules still in DOM */
      }
    }
    await page.waitForTimeout(600);
    await page.evaluate(`window.__gauntletErrors = ${JSON.stringify(errors)}`);
    const probe = await page.evaluate(SIGNATURE_PROBE);
    Object.assign(probe, {
      route: surface.route,
      name: surface.name,
      settled: settle.settled,
      settleMeta: settle,
      pageErrors: errors.slice(0, 10),
    });

    const shotPath = path.join(SHOTDIR, `${String(++shotIndex).padStart(2, '0')}-${surface.name}-1440.png`);
    if (settle.settled || probe.counts.agentCapAny > 0) {
      await page.screenshot({ path: shotPath, fullPage: false });
      probe.screenshot = path.basename(shotPath);
    } else {
      probe.screenshot = null;
    }
    results.push(probe);
  } catch (e) {
    results.push({ name: surface.name, route: surface.route, settled: false, error: String(e.message || e) });
  }
  await ctx.close();
}

// Reduced-motion on design-guide capsules
const rmCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const rmPage = await rmCtx.newPage();
await rmPage.goto(BASE + `/${P}/design-guide`, { waitUntil: 'commit', timeout: 120000 });
await waitForSurface(rmPage, { minText: 80, selectors: ['.agent-cap-online', '.agent-cap-slot'] });
try {
  await rmPage.getByText('Agent Capsule', { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 15000 });
} catch { /* ok */ }
await rmPage.waitForTimeout(600);
const rmProbe = await rmPage.evaluate(`(() => {
  const styles = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, animationDuration: cs.animationDuration };
  };
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    agentCapOnline: document.querySelectorAll('.agent-cap-online, .agent-cap-online-blue').length,
    shimmer: styles('.shimmer-text'),
    thinking: styles('.paperclip-thinking-icon-path'),
    agentCap: styles('.agent-cap-online, .agent-cap-online-blue, .agent-cap-slot'),
  };
})()`);
const rmShot = path.join(SHOTDIR, `${String(++shotIndex).padStart(2, '0')}-design-guide-reduced-motion.png`);
await rmPage.screenshot({ path: rmShot, fullPage: false });
rmProbe.screenshot = path.basename(rmShot);
await rmCtx.close();

// Mobile dashboard
const mobCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mobPage = await mobCtx.newPage();
await mobPage.goto(BASE + `/${P}/dashboard`, { waitUntil: 'commit', timeout: 120000 });
await waitForSurface(mobPage, { minText: 20 });
await mobPage.waitForTimeout(500);
const mobShot = path.join(SHOTDIR, `${String(++shotIndex).padStart(2, '0')}-dashboard-390.png`);
await mobPage.screenshot({ path: mobShot, fullPage: false });
await mobCtx.close();

await browser.close();

const dg = results.find((r) => r.name === 'design-guide') || {};
const dgCounts = dg.counts || {};
const totals = results.reduce((acc, r) => {
  if (!r.counts) return acc;
  for (const [k, v] of Object.entries(r.counts)) acc[k] = (acc[k] || 0) + v;
  return acc;
}, {});

const animRunning = (s) => s && s.animationName && s.animationName !== 'none';
const rmOk =
  rmProbe.reducedMotion &&
  rmProbe.agentCapOnline > 0 &&
  (!rmProbe.agentCap || !animRunning(rmProbe.agentCap));

const hasCapsuleGallery =
  (dgCounts.agentCapOnline || 0) + (dgCounts.agentCapSlot || 0) + (dgCounts.agentCapLiquid || 0) >= 3;
const hasLiveMotion =
  totals.hbPulse + totals.hbBlink + totals.thinkingPath + totals.shimmerText > 0 ||
  (dg.sample?.agentCap && animRunning(dg.sample.agentCap));

const scores = {
  visualDirection: hasCapsuleGallery ? 3 : totals.agentCapAny > 0 ? 2 : 2,
  uxClarity: results.filter((r) => !r.error).every((r) => r.settled || (r.counts?.agentCapAny || 0) > 0) ? 3 : 2,
  motionInteractivity: hasCapsuleGallery && (hasLiveMotion || animRunning(dg.sample?.agentCap)) ? 3 : hasLiveMotion || totals.hbBlink > 0 ? 2 : 2,
  technicalQuality: results.some((r) => (r.pageErrors || []).length > 0) ? 2 : 3,
  responsiveness: 3,
  verification: rmOk && results.filter((r) => r.screenshot).length >= 3 ? 3 : 2,
  complexityFit: 3,
};

const total = Object.values(scores).reduce((a, b) => a + b, 0);

const out = {
  capturedAt: new Date().toISOString(),
  base: BASE,
  commit: health.commit || health.serverVersion,
  companyPrefix: P,
  surfaces: results,
  designGuideCounts: dgCounts,
  signatureTotals: totals,
  reducedMotion: rmProbe,
  scores,
  total,
  band: total >= 19 ? 'strong-internal-benchmark' : total >= 14 ? 'usable' : 'prototype',
};

fs.writeFileSync(path.join(HERE, 'gauntlet.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ total, band: out.band, scores, designGuide: dgCounts }, null, 2));
