/**
 * Turn one or more capture JSONs into the aggregate table the scorecard cites.
 *
 * Aggregates are computed over MEASURED surfaces ONLY. NO-CONTENT and
 * INCONCLUSIVE surfaces are reported as counts and never folded into a mean,
 * because a surface that did not render is not evidence of a clean surface.
 *
 *   node summarize.mjs capture-1440-router-derived.json [capture-390-...json]
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node summarize.mjs <capture.json...>'); process.exit(2); }

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const R = j.results;
  const M = R.filter((r) => r.outcome === 'MEASURED');
  const NC = R.filter((r) => r.outcome === 'NO-CONTENT');
  const IC = R.filter((r) => r.outcome === 'INCONCLUSIVE');

  console.log('\n============================================================');
  console.log(`${f}  ${j.viewport.width}x${j.viewport.height}  ${j.capturedAt}`);
  console.log('============================================================');
  console.log(`router: ${j.routerDerivation.routeRecords} <Route> records ` +
    `${JSON.stringify(j.routerDerivation.classification)}`);
  console.log(`capturable static=${j.routerDerivation.capturableStatic} ` +
    `dynamic patterns=${j.routerDerivation.distinctDynamicPatterns} ` +
    `(resolved ${j.routerDerivation.dynamicResolvedByLiveApi}, unresolved ${j.routerDerivation.dynamicUnresolved})`);
  console.log(`attempted=${R.length}  MEASURED=${M.length} (${pct(M.length, R.length)})  ` +
    `NO-CONTENT=${NC.length}  INCONCLUSIVE=${IC.length}`);

  // DUPLICATE-REDIRECT CORRECTION.
  // `redirected` was recorded per surface but the outcome label never consulted
  // it, so a route that redirects onto another attempted route was counted as
  // its own MEASURED surface. /auth redirects to the board dashboard under
  // local_trusted, passes the content gate on the DASHBOARD's text, and inflates
  // the numerator by one while depicting a view already counted. This recomputes
  // the honest figure from fields the capture already records: how many DISTINCT
  // rendered views the run actually reached.
  const byLanded = new Map();
  for (const r of M) {
    if (!byLanded.has(r.landedPattern)) byLanded.set(r.landedPattern, []);
    byLanded.get(r.landedPattern).push(r.surface);
  }
  const dupes = [...byLanded.entries()].filter(([, v]) => v.length > 1);
  const redirected = M.filter((r) => r.redirected);
  console.log(`  distinct rendered views = ${byLanded.size} (not ${M.length}): ` +
    `${redirected.length} surfaces redirected, ${M.length - byLanded.size} of them onto a view ` +
    `another attempted surface already reached`);
  for (const [landed, from] of dupes) console.log(`    ${landed}  <=  ${from.join(' , ')}`);
  console.log(`content gate proven able to fail: ${j.detector.contentGateProvenAbleToFail}`);

  // --- detector election
  const det = {};
  for (const r of M) det[r.overflowDetector] = (det[r.overflowDetector] || 0) + 1;
  console.log('overflow detector elected by the control:', JSON.stringify(det));
  const ovf = M.map((r) => r.overflowPx).filter((n) => typeof n === 'number');
  const ovfOver = ovf.filter((n) => n > 1);
  console.log(`horizontal overflow at ${j.viewport.width}px: ${ovfOver.length}/${ovf.length} surfaces > 1px, ` +
    `max=${ovf.length ? Math.max(...ovf) : '-'}px`);

  // --- viewport escape (content painted past the right edge, not scrollable)
  const esc = M.filter((r) => r.m.escapedCount > 0);
  console.log(`viewport escape (unreachable past right edge): ${esc.length}/${M.length} surfaces`);

  // --- clipping
  const clip = M.filter((r) => r.m.clippedCount > 0);
  const clipTotal = M.reduce((a, r) => a + r.m.clippedCount, 0);
  console.log(`element-level unreachable clipping: ${clip.length}/${M.length} surfaces, ${clipTotal} elements`);

  // --- targets: WCAG 2.5.8 AA 24px vs 2.5.5 AAA 44px, native excluded
  let enumerated = 0, measured = 0, nativeN = 0, under24 = 0, under44 = 0;
  const worstSurfaces = [];
  for (const r of M) {
    const t = r.m.targets;
    enumerated += r.m.targetsEnumerated;
    measured += t.length;
    const nat = t.filter((x) => x.native).length;
    nativeN += nat;
    const u24 = t.filter((x) => !x.native && x.min < 24).length;
    const u44 = t.filter((x) => !x.native && x.min < 44).length;
    under24 += u24; under44 += u44;
    worstSurfaces.push({ s: r.surface, u24, u44, n: t.length });
  }
  console.log(`targets: enumerated=${enumerated} visible=${measured} native(UA-default)=${nativeN}`);
  console.log(`  author-styled under 24px (WCAG 2.5.8 AA floor): ${under24} (${pct(under24, measured)})`);
  console.log(`  author-styled under 44px (WCAG 2.5.5 AAA):       ${under44} (${pct(under44, measured)})`);
  worstSurfaces.sort((a, b) => b.u24 - a.u24);
  console.log('  worst 8 by sub-24px count:');
  for (const w of worstSurfaces.slice(0, 8)) console.log(`    ${String(w.u24).padStart(4)}  u44=${String(w.u44).padStart(4)}  ${w.s}`);

  // --- minimum rendered text
  const mins = M.map((r) => r.m.minText).filter((n) => typeof n === 'number');
  const u12 = M.reduce((a, r) => a + r.m.under12Count, 0);
  mins.sort((a, b) => a - b);
  console.log(`minimum rendered text: global min=${mins[0]}px  median=${mins[Math.floor(mins.length / 2)]}px  ` +
    `text nodes under 12px=${u12}`);

  // --- contrast
  let cm = 0, cf = 0, si = 0, sn = 0;
  const cWorst = [];
  for (const r of M) {
    cm += r.m.contrast.measured; cf += r.m.contrast.failCount;
    si += r.m.contrast.skippedImage; sn += r.m.contrast.skippedNoBg;
    for (const w of r.m.contrast.worst) cWorst.push({ ...w, s: r.surface });
  }
  cWorst.sort((a, b) => a.ratio - b.ratio);
  // A ratio of ~1.00 means the probe resolved the SAME colour for text and
  // background. That is not a legibility reading, it is the ancestor-walk
  // model failing: the real background is a gradient, an image or a painted
  // sibling/pseudo-element that no single colour can represent. Counting those
  // as contrast failures would overstate the defect, so they are reported
  // separately as unmodelled and are not claimed as failures.
  const unmodelled = cWorst.filter((w) => w.ratio <= 1.05);
  const genuine = cWorst.filter((w) => w.ratio > 1.05);
  console.log(`contrast (WCAG 1.4.3): resolved=${cm} of ${cm + sn + si} text nodes ` +
    `(${pct(cm, cm + sn + si)} coverage); flagged=${cf} (${pct(cf, cm)})`);
  console.log(`  of the flagged sample: ${genuine.length} genuine low-contrast, ` +
    `${unmodelled.length} unmodelled (fg==bg -> text over gradient/image, not a reading)`);
  for (const w of genuine.slice(0, 8)) {
    console.log(`    ${w.ratio}:1 need ${w.need} fs=${w.fs} w=${w.weight} ${w.tag}.${(w.cls || '').slice(0, 34)}  [${w.s}]`);
  }

  // --- typography
  const h1 = M.filter((r) => r.m.typography.h1Present);
  const fams = {};
  for (const r of M) fams[r.m.typography.bodyType.family] = (fams[r.m.typography.bodyType.family] || 0) + 1;
  const h1Sizes = {};
  for (const r of h1) h1Sizes[r.m.typography.h1Size] = (h1Sizes[r.m.typography.h1Size] || 0) + 1;
  const breaks = M.filter((r) => r.m.typography.headingOrderBreaks > 0);
  console.log(`typography: h1 present on ${h1.length}/${M.length} measured surfaces`);
  console.log(`  body family: ${JSON.stringify(fams)}`);
  console.log(`  h1 computed sizes: ${JSON.stringify(h1Sizes)}`);
  console.log(`  heading-order breaks on ${breaks.length} surfaces`);
  const sizeSpread = {};
  for (const r of M) sizeSpread[r.m.typography.distinctTextSizes] = (sizeSpread[r.m.typography.distinctTextSizes] || 0) + 1;
  console.log(`  distinct rendered text sizes per surface: ${JSON.stringify(sizeSpread)}`);

  // --- motion / reduced motion
  const rm = M.filter((r) => r.reducedMotion && !r.reducedMotion.error);
  const rmActive = rm.filter((r) => r.reducedMotion.mediaQueryActive);
  const rmStillAnimating = rm.filter((r) => r.reducedMotion.animated > 0);
  const anim = M.reduce((a, r) => a + r.m.motion.animated, 0);
  const inf = M.reduce((a, r) => a + r.m.motion.infinite, 0);
  console.log(`motion: animated elements total=${anim} infinite=${inf}`);
  console.log(`  reduced-motion pass sampled on ${rm.length} surfaces; media query active on ${rmActive.length}; ` +
    `still animating under reduce: ${rmStillAnimating.length}`);

  // --- console errors / bad responses
  const withErr = M.filter((r) => r.consoleErrorCount > 0);
  const withBad = M.filter((r) => (r.badResponses || []).length > 0);
  const badAgg = {};
  for (const r of R) for (const b of r.badResponses || []) badAgg[b] = (badAgg[b] || 0) + 1;
  console.log(`console errors on ${withErr.length}/${M.length} measured surfaces; 4xx/5xx on ${withBad.length}`);
  const badTop = Object.entries(badAgg).sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [k, v] of badTop) console.log(`    ${String(v).padStart(3)}x ${k}`);

  // --- settle
  const ceil = R.filter((r) => r.settleMode === 'ceiling-reached');
  const never = R.filter((r) => r.settleMode === 'never-mounted');
  const st = M.map((r) => r.settleMs).sort((a, b) => a - b);
  console.log(`settle: median=${st[Math.floor(st.length / 2)]}ms p90=${st[Math.floor(st.length * 0.9)]}ms ` +
    `max=${st[st.length - 1]}ms; ceiling-reached=${ceil.length} never-mounted=${never.length}`);

  if (NC.length) console.log('\nNO-CONTENT (rendered no distinct main content; excluded from aggregates):\n  ' + NC.map((r) => r.surface).join('\n  '));
  if (IC.length) console.log('\nINCONCLUSIVE (a control did not move; nothing here is trusted):\n  ' + IC.map((r) => r.surface).join('\n  '));
  if (j.routerDerivation.dynamicUnresolvedPatterns.length) {
    console.log(`\nDYNAMIC PATTERNS NOT REACHABLE ON THIS INSTANCE (${j.routerDerivation.dynamicUnresolvedPatterns.length}) - denominator gap:`);
    for (const d of j.routerDerivation.dynamicUnresolvedPatterns) console.log(`  ${d.pattern}   missing: ${d.missing.join(',')}`);
  }
}
