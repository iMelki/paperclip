/**
 * Cold-load cost of one surface, measured in the browser rather than inferred
 * from `ls -l` on ui/dist. Reports what the client actually pulls before the
 * app paints text, which is the number the "perceived performance" dimension
 * needs and the number ten rounds of code-only audits could not produce.
 *
 * Cache is cold by construction (a fresh context, no service worker warm-up).
 * `timeToText` is measured from navigation start to the first poll at which
 * document.body.innerText exceeds 20 characters, polled at 100ms, so it is a
 * ceiling accurate to ~100ms, not a Web Vitals LCP.
 *
 *   BASE=http://127.0.0.1:3197 node loadcost.mjs /ASI/dashboard out.json
 */
import fs from 'node:fs';

const PW = 'S:/source/CCAI/Assistants/tools/paperclip/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';
const { chromium } = await import(`file://${PW}`);
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
const REL = process.argv[2] || '/';
const OUT = process.argv[3] || null;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const byType = {};
let requests = 0, totalBytes = 0;
page.on('response', async (r) => {
  requests++;
  try {
    const h = await r.allHeaders();
    const len = Number(h['content-length'] || 0);
    const ct = (h['content-type'] || 'unknown').split(';')[0];
    byType[ct] = byType[ct] || { n: 0, bytes: 0 };
    byType[ct].n++; byType[ct].bytes += len;
    totalBytes += len;
  } catch { /* response body may be gone */ }
});

const t0 = Date.now();
await page.goto(BASE + REL, { waitUntil: 'commit', timeout: 60000 });
let timeToText = null;
for (let i = 0; i < 600; i++) {
  const len = await page.evaluate('(document.body.innerText||"").trim().length').catch(() => 0);
  if (len > 20) { timeToText = Date.now() - t0; break; }
  await page.waitForTimeout(100);
}
// let late chunks land so the byType table is not truncated mid-flight
await page.waitForTimeout(3000);
const domNodes = await page.evaluate('document.getElementsByTagName("*").length');
const out = {
  base: BASE, path: REL, measuredAt: new Date().toISOString(),
  timeToFirstTextMs: timeToText,
  requests, totalContentLengthBytes: totalBytes,
  byContentType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes)),
  domNodes
};
console.log(JSON.stringify(out, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
await browser.close();
