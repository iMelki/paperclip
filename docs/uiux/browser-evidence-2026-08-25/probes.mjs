/**
 * Paperclip UI measurement probes — FIRST BROWSER CAPTURE of this app.
 *
 * ADAPTED, not reinvented, from job-pipeline-os
 * docs/uiux/browser-evidence-2026-08-24/measure.mjs (itself adapted from the
 * memsys round-9 harness). Carried over in substance:
 *   - the WCAG 2.5.8 native-vs-author-sized target discrimination
 *   - the minimum-rendered-text walker
 *   - the element-level "unreachable content" clipping definition, including
 *     its sr-only / clip-path / ellipsis / scrollable exclusions
 *   - three outcomes (MEASURED / INCONCLUSIVE), never a silent score
 *
 * THREE deliberate differences from the jpos harness, each stated:
 *
 * 1. THE DOCUMENT-LEVEL OVERFLOW DETECTOR IS DEAD ON THIS APP AND IS TREATED
 *    AS DEAD. jpos treats `document.body.scrollWidth - document.body.clientWidth`
 *    as the LIVE reflow detector. Paperclip sets `body { height:100%; overflow:hidden }`
 *    (ui/src/index.css) and the app shell adds `overflow-clip` / `overflow-x-clip`
 *    (ui/src/components/Layout.tsx). A 2500px element injected INSIDE <main>
 *    leaves body at 0 and documentElement at 0 while the shell registers 2126px.
 *    A 2500px element injected as a direct child of <body> DOES move body to
 *    1060px — so a control placed on <body>, which is where the obvious control
 *    goes, would have "proven the probe" and been wrong. Every control here is
 *    injected where real content lives.
 *
 * 2. SHELL OVERFLOW IS THE LIVE REFLOW DETECTOR. The clipping boundary (the
 *    nearest ancestor of <main> whose computed overflow-x is clip|hidden) is
 *    where paperclip's horizontal overflow actually lands, so that is measured,
 *    alongside a viewport-escape count for content painted past the right edge.
 *
 * 3. CONTRAST AND MOTION ARE MEASURED, not estimated. The jpos bundle scored
 *    eight rubric dimensions off a harness that measured five; that overreach
 *    was called out. Contrast (1.4.3) and motion (2.3.3 + prefers-reduced-motion)
 *    each get a probe and each gets its own positive control below.
 */

export const MEASURE = `(() => {
  const round = (n) => Math.round(n * 100) / 100;
  const vw = document.documentElement.clientWidth;

  // ---------- overflow ----------
  // RETIRED on this app; recorded so it can be re-proven dead in every run.
  const retiredBodyOverflow = document.body.scrollWidth - document.body.clientWidth;
  const retiredDocOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

  // LIVE detector: the clipping boundary that actually absorbs overflow here.
  const main = document.querySelector('main') || document.body;
  let shellOverflow = 0, shellCls = null;
  {
    let n = main;
    while (n && n !== document.documentElement) {
      const ox = getComputedStyle(n).overflowX;
      const over = n.scrollWidth - n.clientWidth;
      if ((ox === 'clip' || ox === 'hidden') && over > shellOverflow) {
        shellOverflow = over;
        shellCls = (typeof n.className === 'string' ? n.className : '').slice(0, 70);
      }
      n = n.parentElement;
    }
  }
  const mainOverflow = main.scrollWidth - main.clientWidth;

  // Content painted past the right viewport edge that is NOT inside a
  // scrollable ancestor (a scroll container is reachable, so it is not damage).
  const escaped = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (r.right <= vw + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed') continue;
    let scrollableAncestor = false;
    let p = el.parentElement;
    while (p) {
      const px = getComputedStyle(p).overflowX;
      if (px === 'auto' || px === 'scroll') { scrollableAncestor = true; break; }
      p = p.parentElement;
    }
    if (scrollableAncestor) continue;
    escaped.push({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      right: round(r.right), overBy: round(r.right - vw),
      text: (el.textContent || '').trim().slice(0, 40)
    });
  }
  escaped.sort((a, b) => b.overBy - a.overBy);

  // ---------- interactive targets (WCAG 2.5.5 AAA 44px / 2.5.8 AA 24px) ----------
  const SEL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])';
  const enumerated = document.querySelectorAll(SEL).length;
  const targets = [];
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.type === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const nativeKind =
      (tag === 'input' && ['checkbox','radio','file','color','range','date','time'].includes(type)) ? 'input-' + type :
      (tag === 'select') ? 'select' : null;
    const authorSized =
      cs.width !== 'auto' || cs.height !== 'auto' ||
      cs.padding !== '0px' || cs.minWidth !== 'auto' || cs.minHeight !== 'auto';
    const isNative = Boolean(nativeKind) && !authorSized;
    const w = round(r.width), h = round(r.height);
    targets.push({
      tag, type, min: Math.min(w, h), w, h, native: isNative, nativeKind,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      text: (el.textContent || '').trim().slice(0, 40)
    });
  }

  // ---------- rendered text size ----------
  let minText = null; const under12 = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n2;
  while ((n2 = walker.nextNode())) {
    const t = (n2.nodeValue || '').trim();
    if (!t) continue;
    const p = n2.parentElement;
    if (!p || seen.has(p)) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = p.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    seen.add(p);
    const size = parseFloat(cs.fontSize);
    if (!Number.isFinite(size)) continue;
    if (minText === null || size < minText) minText = size;
    if (size < 12) under12.push({ fs: round(size), tag: p.tagName.toLowerCase(), text: t.slice(0, 30) });
  }

  // ---------- element-level clipping: genuinely unreachable content ----------
  const clipped = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) continue;
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;   // sr-only 1px pattern
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.clipPath && cs.clipPath !== 'none') continue;
    if (cs.position === 'absolute' && cs.clip && cs.clip !== 'auto') continue;
    const ox = cs.overflowX;
    if (ox === 'auto' || ox === 'scroll') continue;              // reachable by scrolling
    if (cs.textOverflow === 'ellipsis') continue;                // signalled truncation
    clipped.push({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowPx: over, overflowX: ox,
      text: (el.textContent || '').trim().slice(0, 40)
    });
  }
  clipped.sort((a, b) => b.overflowPx - a.overflowPx);

  // ---------- contrast (WCAG 1.4.3) ----------
  // Effective background = first ancestor with an opaque background-color.
  // Text over an image or gradient is NOT scored (counted as skippedImage)
  // because a single colour cannot represent it.
  const srgb = (c) => { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  // COLOUR NORMALISATION VIA CANVAS, not via an rgb() regex.
  // paperclip's entire token system is OKLCH (ui/src/index.css), and Chromium
  // returns getComputedStyle().backgroundColor as 'oklch(0.145 0 0)' verbatim.
  // The previous rgb()-only parser returned null for every one of those, the
  // probe recorded "no opaque background", and the node was skipped. MEASURED
  // on this app at 1440px: that parser resolved a background for 8.3% of text
  // nodes (738 of 8890) and reported a failure rate over that 8% as if it were
  // the page. Canvas fillStyle round-trips ANY CSS colour the browser accepts
  // - oklch(), color(), hsl(), named - to a legacy sRGB serialisation, so the
  // parser IS the browser and cannot drift from what it actually paints.
  const __ctx2d = document.createElement('canvas').getContext('2d');
  const __colorCache = new Map();
  const parse = (input) => {
    const str = String(input || '').trim();
    if (!str) return null;
    if (__colorCache.has(str)) return __colorCache.get(str);
    let out = null;
    try {
      // Sentinel: an invalid assignment leaves fillStyle unchanged, so a value
      // that reads back as the sentinel is invalid unless it WAS the sentinel.
      __ctx2d.fillStyle = '#010203';
      __ctx2d.fillStyle = str;
      if (__ctx2d.fillStyle === '#010203' && str.toLowerCase() !== '#010203') {
        // invalid colour: the assignment was rejected and fillStyle held.
        out = null;
      } else {
        // MEASURED, not assumed: Chromium's fillStyle GETTER round-trips
        // 'oklch(0.145 0 0)' verbatim - it converts rgb() to '#09090b' and
        // 'rebeccapurple' to '#663399', but leaves modern colour syntax alone.
        // So serialisation cannot be the parser on an OKLCH-token app. Painting
        // one pixel and reading it back forces the browser's own conversion to
        // sRGB bytes, which is exactly the colour the user sees.
        __ctx2d.clearRect(0, 0, 1, 1);
        __ctx2d.fillRect(0, 0, 1, 1);
        const d = __ctx2d.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch (e) { out = null; }
    __colorCache.set(str, out);
    return out;
  };
  const ratio = (f, b) => {
    const L1 = lum(f.r, f.g, f.b), L2 = lum(b.r, b.g, b.b);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const contrast = { measured: 0, skippedImage: 0, skippedNoBg: 0, failList: [] };
  for (const p of seen) {
    const cs = getComputedStyle(p);
    const fg = parse(cs.color);
    if (!fg) { contrast.skippedNoBg++; continue; }
    // EFFECTIVE BACKGROUND BY COMPOSITING, not by "first ancestor with
    // alpha >= 0.95".
    //
    // MEASURED failure of the old rule: paperclip's sidebar count badge paints
    // 'oklab(0.577 0.217662 0.112464 / 0.9)' - a red pill at alpha 0.902. The
    // 0.95 threshold rejected it as non-opaque, the walk continued through
    // transparent ancestors to the white page background, and near-white badge
    // text was scored against WHITE at 1.09:1 and reported as a severe
    // contrast failure on EVERY board surface. It is a red badge with white
    // text and it is fine. Tailwind's /90-style opacity utilities make this
    // shape common, so the threshold did not mis-score one element, it
    // mis-scored a whole class of them.
    //
    // Correct model: collect every background layer from the element upward
    // until an opaque one (or an image, which a single colour cannot
    // represent), then composite them top-over-bottom.
    const layers = [];
    let over = p, imaged = false, base = null;
    while (over) {
      const ocs = getComputedStyle(over);
      if (ocs.backgroundImage && ocs.backgroundImage !== 'none') { imaged = true; break; }
      const c = parse(ocs.backgroundColor);
      if (c && c.a > 0.001) {
        layers.push(c);
        if (c.a >= 0.999) { base = c; break; }
      }
      over = over.parentElement;
    }
    if (imaged) { contrast.skippedImage++; continue; }
    if (!base) { contrast.skippedNoBg++; continue; }
    let bg = base;
    for (let i = layers.length - 2; i >= 0; i--) {
      const t = layers[i];
      bg = {
        r: t.r * t.a + bg.r * (1 - t.a),
        g: t.g * t.a + bg.g * (1 - t.a),
        b: t.b * t.a + bg.b * (1 - t.a),
        a: 1
      };
    }
    const eff = fg.a >= 1 ? fg : {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a)
    };
    const cr = ratio(eff, bg);
    contrast.measured++;
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      contrast.failList.push({
        ratio: round(cr), need, fs: round(size), weight, large,
        color: cs.color,
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        tag: p.tagName.toLowerCase(),
        cls: (typeof p.className === 'string' ? p.className : '').slice(0, 50),
        text: (p.textContent || '').trim().slice(0, 34)
      });
    }
  }
  contrast.failList.sort((a, b) => a.ratio - b.ratio);
  contrast.failCount = contrast.failList.length;
  contrast.worst = contrast.failList.slice(0, 8);
  delete contrast.failList;

  // ---------- motion (2.3.3 + prefers-reduced-motion) ----------
  const dur = (s) => (s || '').split(',').map((x) => parseFloat(x) || 0).reduce((a, b) => Math.max(a, b), 0);
  const motion = { animated: 0, transitioned: 0, infinite: 0, samples: [] };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    const a = dur(cs.animationDuration), t = dur(cs.transitionDuration);
    if (a > 0) {
      motion.animated++;
      if ((cs.animationIterationCount || '').includes('infinite')) motion.infinite++;
      if (motion.samples.length < 8) motion.samples.push({
        kind: 'animation', name: cs.animationName, dur: a,
        iter: cs.animationIterationCount, tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50)
      });
    }
    if (t > 0) motion.transitioned++;
  }
  motion.reducedMotionActive = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- typography ----------
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      lvl: Number(e.getAttribute('aria-level')) || Number(e.tagName.slice(1)) || null,
      fs: round(parseFloat(getComputedStyle(e).fontSize)),
      weight: getComputedStyle(e).fontWeight,
      text: (e.textContent || '').trim().slice(0, 40)
    }));
  let headingOrderBreaks = 0;
  let prev = 0;
  for (const h of headings) {
    if (h.lvl && prev && h.lvl > prev + 1) headingOrderBreaks++;
    if (h.lvl) prev = h.lvl;
  }
  const sizes = {};
  for (const p of seen) { const s = round(parseFloat(getComputedStyle(p).fontSize)); sizes[s] = (sizes[s] || 0) + 1; }
  const h1 = document.querySelector('h1, [role="heading"][aria-level="1"]');
  const bodyProbe = document.createElement('p');
  bodyProbe.textContent = 'x'; bodyProbe.style.margin = '0';
  document.body.appendChild(bodyProbe);
  const bcs = getComputedStyle(bodyProbe);
  const bodyType = { family: bcs.fontFamily.slice(0, 60), size: bcs.fontSize, weight: bcs.fontWeight };
  bodyProbe.remove();

  return {
    vw,
    hasMain: Boolean(document.querySelector('main')),
    shellOverflow: round(shellOverflow), shellCls, mainOverflow: round(mainOverflow),
    retiredBodyOverflow: round(retiredBodyOverflow), retiredDocOverflow: round(retiredDocOverflow),
    escapedCount: escaped.length, escapedWorst: escaped.slice(0, 6),
    targetsEnumerated: enumerated, targetsMeasured: targets.length, targets,
    minText: minText === null ? null : round(minText),
    textNodesMeasured: seen.size,
    under12Count: under12.length, under12Sample: under12.slice(0, 6),
    clippedCount: clipped.length, clippedWorst: clipped.slice(0, 8),
    contrast, motion,
    typography: {
      h1Present: Boolean(h1),
      h1Size: h1 ? round(parseFloat(getComputedStyle(h1).fontSize)) : null,
      h1Text: h1 ? (h1.textContent || '').trim().slice(0, 50) : null,
      bodyType, headingCount: headings.length, headingOrderBreaks,
      headings: headings.slice(0, 14),
      distinctTextSizes: Object.keys(sizes).length,
      sizeHistogram: sizes
    },
    textLength: (document.body.innerText || '').length,
    title: document.title
  };
})()`;

/**
 * Positive controls. EVERY control is injected inside <main>, i.e. where real
 * content lives — a control on <body> escapes paperclip's clipping shell and
 * would falsely validate the dead document-level detector (header note 1).
 *
 * Seven detectors, seven controls: shell overflow, viewport escape, tiny
 * target, tiny text, unreachable clipping (plus a scrollable twin that must
 * NOT be counted), contrast (plus a high-contrast twin that must NOT be
 * counted), and motion.
 */
export const CONTROL_ON = `(() => {
  // ANCHOR. The control must be injected where real content lives. <main> is
  // the right anchor on every board surface. A handful of unprefixed surfaces
  // (/auth, /ux-lab/*, the dev perf harness) render with NO <main> landmark at
  // all — that is itself a finding — and on those the overflow detector has
  // nothing to anchor to. Rather than silently falling back to <body>, which
  // sits OUTSIDE paperclip's clipping shell and would validate the retired
  // document-level detector, the anchor is reported so the runner can mark the
  // overflow detector unanchored and refuse to score overflow on that surface.
  const mainEl = document.querySelector('main');
  const rootChild = document.getElementById('root')?.firstElementChild || null;
  const anchorEl = mainEl || rootChild || document.body;
  const anchor = mainEl ? 'main' : (rootChild ? 'root' : 'body');
  const main = anchorEl;
  const host = document.createElement('div');
  host.id = '__ctl_host__';
  main.appendChild(host);

  const wide = document.createElement('div');
  wide.id = '__ctl_overflow__';
  // flex:0 0 auto + min-width so a flex or grid parent cannot shrink the
  // control away. Without it the control silently does nothing inside a flex
  // column and the run reports "detector did not move" on a healthy page.
  wide.style.cssText = 'width:2500px;min-width:2500px;flex:0 0 auto;height:4px;position:relative;background:#123;';
  host.appendChild(wide);

  const tiny = document.createElement('button');
  tiny.id = '__ctl_tiny__';
  tiny.style.cssText = 'width:11px;height:11px;padding:0;min-width:0;min-height:0;font-size:7px;';
  tiny.textContent = 'z';
  host.appendChild(tiny);

  // must be COUNTED as clipped: unreachable, no scroll, no ellipsis
  const clip = document.createElement('div');
  clip.id = '__ctl_clip__';
  clip.style.cssText = 'width:50px;height:20px;overflow:hidden;white-space:nowrap;';
  clip.textContent = 'THIS CONTENT IS UNREACHABLE BY ANY MEANS AT ALL';
  host.appendChild(clip);

  // must NOT be counted: same overflow, reachable by scrolling
  const scrollable = document.createElement('div');
  scrollable.id = '__ctl_scrollok__';
  scrollable.style.cssText = 'width:50px;height:20px;overflow-x:auto;white-space:nowrap;';
  scrollable.textContent = 'THIS CONTENT IS REACHABLE BY SCROLLING IT SIDEWAYS';
  host.appendChild(scrollable);

  // contrast: #777 on #888 is 1.23:1, far under 4.5 — must be flagged
  const bad = document.createElement('div');
  bad.id = '__ctl_contrast__';
  bad.style.cssText = 'background:#888888;color:#777777;font-size:14px;width:200px;height:18px;';
  bad.textContent = 'CONTRAST CONTROL LOW';
  host.appendChild(bad);

  // contrast: #000 on #fff is 21:1 — must NOT be flagged
  const good = document.createElement('div');
  good.id = '__ctl_contrast_ok__';
  good.style.cssText = 'background:#ffffff;color:#000000;font-size:14px;width:200px;height:18px;';
  good.textContent = 'CONTRAST CONTROL HIGH';
  host.appendChild(good);

  // motion
  const style = document.createElement('style');
  style.id = '__ctl_style__';
  style.textContent = '@keyframes __ctlspin__{from{transform:rotate(0)}to{transform:rotate(360deg)}} #__ctl_motion__{animation:__ctlspin__ 1.5s linear infinite;width:20px;height:20px;background:#345;}';
  document.head.appendChild(style);
  const mo = document.createElement('div');
  mo.id = '__ctl_motion__';
  host.appendChild(mo);

  let shell = 0, n = main;
  while (n && n !== document.documentElement) {
    const ox = getComputedStyle(n).overflowX;
    const over = n.scrollWidth - n.clientWidth;
    if ((ox === 'clip' || ox === 'hidden') && over > shell) shell = over;
    n = n.parentElement;
  }
  return {
    anchor,
    shell,
    // The anchor's OWN horizontal overflow. On paperclip's board surfaces
    // <main> is itself a horizontal scroll container, so a 2500px child grows
    // main.scrollWidth and moves NOTHING else: no clip ancestor grows (the
    // scroll container absorbs it) and nothing paints past the viewport edge
    // (the escape probe correctly excludes anything inside a scrollable
    // ancestor). Without this reading, every board surface reports "no
    // detector moved" and any overflow number taken from it is vacuous.
    mainScroll: main.scrollWidth - main.clientWidth,
    retiredBody: document.body.scrollWidth - document.body.clientWidth,
    retiredDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    clipOverflowPx: clip.scrollWidth - clip.clientWidth,
    scrollableOverflowPx: scrollable.scrollWidth - scrollable.clientWidth
  };
})()`;

export const CONTROL_OFF = `(() => {
  document.getElementById('__ctl_host__')?.remove();
  document.getElementById('__ctl_style__')?.remove();
  return true;
})()`;
