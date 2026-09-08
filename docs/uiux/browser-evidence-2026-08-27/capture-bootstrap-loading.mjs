/**
 * Live bootstrap loading capture — PaperclipLoading on unprefixed board redirect.
 * BASE=http://127.0.0.1:5113 node capture-bootstrap-loading.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = new URL('../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(PW.href);
const BASE = process.env.BASE || 'http://127.0.0.1:5113';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'gauntlet-shots', '15-bootstrap-loading-live-1440.png');
const ROUTE = '/dashboard';

async function api(p) {
  const r = await fetch(BASE + p);
  return r.ok ? r.json() : null;
}

const health = await api('/api/health');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

let companiesReleased = false;
const hold = new Promise(() => {});
await page.route('**/api/companies**', async (route) => {
  if (!companiesReleased && route.request().method() === 'GET') {
    await hold;
  }
  await route.continue();
});

await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'commit', timeout: 120000 });

let probe = null;
try {
  await page.waitForSelector('.paperclip-thinking-icon', { timeout: 45000 });
} catch {
  /* best-effort */
}

probe = await page.evaluate(() => {
  const el = document.querySelector('.paperclip-thinking-icon-path');
  const cs = el ? getComputedStyle(el) : null;
  return {
    title: document.title,
    path: location.pathname,
    counts: {
      thinkingIcon: document.querySelectorAll('.paperclip-thinking-icon').length,
      thinkingPath: document.querySelectorAll('.paperclip-thinking-icon-path').length,
      shimmer: document.querySelectorAll('.shimmer-text').length,
    },
    animation: cs
      ? { animationName: cs.animationName, animationDuration: cs.animationDuration }
      : null,
  };
});

await page.screenshot({ path: SHOT, fullPage: false });
companiesReleased = true;
await browser.close();

const out = {
  capturedAt: new Date().toISOString(),
  surface: 'factory :5113 unprefixed board redirect (held /api/companies)',
  base: BASE,
  route: ROUTE,
  healthCommit: health?.commit ?? null,
  ...probe,
  screenshot: path.basename(SHOT),
  pass: (probe?.counts?.thinkingIcon ?? 0) >= 1,
};

fs.writeFileSync(path.join(HERE, 'bootstrap-loading-live-proof.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
