/**
 * Reduced-motion thinking-icon capture — Delight 8+ gate (run 6).
 * BASE=http://127.0.0.1:5113 node capture-thinking-icon-rm.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = new URL('../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(PW.href);
const BASE = process.env.BASE || 'http://127.0.0.1:5113';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'gauntlet-shots', '14-thinking-icon-reduced-motion-1440.png');

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    (page.__errors ||= []).push(msg.text());
  }
});
await page.addInitScript(() => {
  window.__captureErrors = [];
  window.addEventListener('error', (e) => window.__captureErrors.push(String(e.message)));
});
await page.goto(`${BASE}/ux-lab/loading-chrome`, { waitUntil: 'commit', timeout: 120000 });
try {
  await page.waitForSelector('.paperclip-thinking-icon', { timeout: 90000 });
} catch {
  await page.waitForTimeout(3000);
}

const probe = await page.evaluate(() => {
  const el = document.querySelector('.paperclip-thinking-icon-path');
  const cs = el ? getComputedStyle(el) : null;
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    title: document.title,
    rootLen: (document.getElementById('root')?.innerText || '').trim().length,
    consoleErrors: window.__captureErrors || [],
    counts: {
      thinkingIcon: document.querySelectorAll('.paperclip-thinking-icon').length,
      thinkingPath: document.querySelectorAll('.paperclip-thinking-icon-path').length,
    },
    animation: cs
      ? { animationName: cs.animationName, animationDuration: cs.animationDuration }
      : null,
  };
});

await page.screenshot({ path: SHOT, fullPage: false });
await browser.close();

const out = {
  capturedAt: new Date().toISOString(),
  surface: 'factory :5113 ux-lab loading-chrome (reduced-motion)',
  base: BASE,
  route: '/ux-lab/loading-chrome',
  ...probe,
  screenshot: path.basename(SHOT),
  pass:
    probe.reducedMotion &&
    probe.counts.thinkingIcon === 1 &&
    probe.animation?.animationName === 'none',
};

fs.writeFileSync(path.join(HERE, 'thinking-icon-reduced-motion-proof.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
