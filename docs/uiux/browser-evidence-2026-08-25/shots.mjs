/**
 * Curated screenshot pass for the committed evidence bundle. The full sweep's
 * measurement JSONs cover all surfaces; committing 86x2 PNGs would bloat the
 * repo, so this captures a REPRESENTATIVE subset at both widths (precedent:
 * job-pipeline-os browser-evidence-2026-08-24 committed 5x2).
 *
 * Usage: BASE=http://127.0.0.1:3197 node shots.mjs [width ...]
 * Default widths: 1440 390.
 *
 * Each shot is gated on real content (visible <main> text, not chrome, not
 * skeleton) — a screenshot of a loading shell is worse than no screenshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = new URL('../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(PW.href);

const __base = process.env.BASE || 'http://127.0.0.1:3197';
if (/:3199(\/|$)/.test(__base) && process.env.ALLOW_REAL_INSTANCE !== 'i-understand-this-is-real-operator-data') {
  console.error('REFUSED: ' + __base + ' serves real operator context. Use the isolated :3197 instance.');
  process.exit(2);
}
const BASE = __base;
const WIDTHS = process.argv.slice(2).map(Number).filter(Boolean);
if (WIDTHS.length === 0) WIDTHS.push(1440, 390);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTDIR = path.join(HERE, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });

async function api(p) { const r = await fetch(BASE + p); return r.ok ? r.json() : null; }
const companies = await api('/api/companies');
const company = companies?.find((c) => c.issuePrefix === 'NOR') || companies?.[0];
if (!company) { console.error('no company'); process.exit(2); }
const P = company.issuePrefix;
const issues = await api(`/api/companies/${company.id}/issues`);
const projects = await api(`/api/companies/${company.id}/projects`);
const agents = await api(`/api/companies/${company.id}/agents`);
const issueId = issues?.find((i) => /Arm stalls/.test(i.title || ''))?.id ?? issues?.[0]?.id;
const projectId = projects?.[0]?.id;
const agentId = agents?.find((a) => a.name === 'Ada Chen')?.id ?? agents?.[0]?.id;

const SUBSET = [
  ['dashboard', `/${P}/dashboard`],
  ['issues', `/${P}/issues`],
  ['issue-detail', `/${P}/issues/${issueId}`],
  ['inbox-mine', `/${P}/inbox/mine`],
  ['projects', `/${P}/projects`],
  ['project-detail', `/${P}/projects/${projectId}`],
  ['agents-all', `/${P}/agents/all`],
  ['agent-detail', `/${P}/agents/${agentId}`],
  ['goals', `/${P}/goals`],
  ['company-settings', `/${P}/company/settings`],
  ['skills-studio', `/${P}/skills/studio`],
  ['design-guide', `/${P}/design-guide`]
];

const browser = await chromium.launch();
for (const width of WIDTHS) {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  for (const [name, url] of SUBSET) {
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 45000 });
      // content gate: visible main text, settled twice
      let ok = false;
      for (let i = 0; i < 40; i++) {
        const len = await page.evaluate(
          `(document.querySelector('main')?.innerText || '').trim().length`
        );
        const skel = await page.evaluate(
          `document.querySelectorAll('.animate-pulse,[aria-busy="true"],[role="progressbar"]').length`
        );
        if (len > 40 && skel === 0) { ok = true; break; }
        await page.waitForTimeout(250);
      }
      if (!ok) { console.log(`SKIP  ${name}-${width} (no content)`); continue; }
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTDIR, `${name}-${width}.png`), type: 'png' });
      console.log(`shot  ${name}-${width}.png`);
    } catch (e) {
      console.log(`FAIL  ${name}-${width}: ${String(e).slice(0, 100)}`);
    }
  }
  await ctx.close();
}
await browser.close();
