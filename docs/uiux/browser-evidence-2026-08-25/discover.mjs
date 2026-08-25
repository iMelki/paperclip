/**
 * Assertion-discovery pass. Committed because it is HOW the `expect` strings in
 * surfaces.mjs were chosen, and choosing them badly is the specific failure
 * this bundle exists to avoid.
 *
 * The first sweep of this app asserted strings like "Search", "Ada Chen",
 * "Projects" and "gent". Every one of those is in the persistent sidebar, so
 * each would have passed on a blank skeleton of any other route. The runner's
 * chrome gate caught 22 of them. This pass renders each surface properly and
 * prints the text that is in <main> and NOT in the chrome, so assertions can be
 * taken from content that only that surface produces.
 */
import fs from 'node:fs';
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


async function api(p) { const r = await fetch(BASE + p); return r.ok ? r.json() : null; }
const companies = await api('/api/companies');
const company = (companies || []).find((c) => c.issuePrefix === PREFIX) || (companies || [])[0];
const [issues, projects, agents, goals] = await Promise.all([
  api(`/api/companies/${company.id}/issues`), api(`/api/companies/${company.id}/projects`),
  api(`/api/companies/${company.id}/agents`), api(`/api/companies/${company.id}/goals`)
]);
const pick = (a, f) => (Array.isArray(a) ? a.find(f) || a[0] : null);
const ids = {
  issueId: pick(issues, (i) => /Arm stalls/.test(i.title || ''))?.id,
  projectId: pick(projects, (p) => p.name === 'Kitchen Autonomy')?.id,
  agentId: pick(agents, (a) => a.name === 'Ada Chen')?.id,
  goalId: pick(goals, (g) => /Ship the v3/.test(g.title || ''))?.id
};

const SURFACES = [
  ...STATIC_SURFACES, ...dynamicSurfaces(ids),
  ...APP_SURFACES
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/${PREFIX}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const chrome = (await page.evaluate(`Array.from(document.querySelectorAll('nav, aside, header, [data-sidebar]')).map(n=>n.innerText||'').join(' ').replace(/\\s+/g,' ')`)).toLowerCase();

const out = [];
for (const s of SURFACES) {
  const url = BASE + (s.unprefixed ? s.path : `/${PREFIX}${s.path}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2200);
    const d = await page.evaluate(`(() => {
      const m = document.querySelector('main');
      const chromeNodes = Array.from(document.querySelectorAll('nav, aside, header, [data-sidebar]'));
      const chromeText = chromeNodes.map((n) => n.innerText || '').join(' ');
      const mainText = m ? (m.innerText || '') : '';
      const h = Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => (e.textContent||'').trim()).filter(Boolean);
      return {
        finalPath: location.pathname,
        title: document.title,
        mainLen: mainText.replace(/\\s+/g,' ').trim().length,
        headings: h.slice(0, 8),
        mainSample: mainText.replace(/\\s+/g,' ').trim().slice(0, 260),
        chromeLen: chromeText.length
      };
    })()`);
    // candidate assertions: headings that are not chrome
    const cands = d.headings.filter((h) => h.length >= 4 && !chrome.includes(h.toLowerCase()));
    out.push({ id: s.id, path: s.path, ...d, candidates: cands.slice(0, 4), currentExpect: s.expect,
      currentExpectIsChrome: chrome.includes(String(s.expect).toLowerCase()) });
    console.log(`${s.id.padEnd(22)} main=${String(d.mainLen).padEnd(6)} final=${d.finalPath.padEnd(46)} cands=${JSON.stringify(cands.slice(0,3))}`);
  } catch (e) {
    out.push({ id: s.id, path: s.path, error: String(e).slice(0, 140) });
    console.log(`${s.id.padEnd(22)} ERROR ${String(e).slice(0, 90)}`);
  }
}
await browser.close();
fs.writeFileSync('./discovery.json', JSON.stringify({ chromeSample: chrome.slice(0, 300), surfaces: out }, null, 2));
console.log('\nwrote ./discovery.json');
