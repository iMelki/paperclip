/**
 * Independent route derivation for paperclip's UI — the check behind the
 * enumerated-surface denominator, committed so the "how many surfaces exist"
 * figure is reproducible from source instead of quoted between rounds.
 *
 * Reads ui/src/App.tsx at the commit under test, extracts every <Route> tag
 * (multi-line tolerant), and classifies each path:
 *   redirect — element is <Navigate> or a known redirect component
 *   splat    — path contains '*'
 *   dynamic  — path contains ':param'
 *   static   — everything else
 * `agents/${tab}` template routes are expanded against AGENT_FILTER_TABS
 * (ui/src/pages/Agents.tsx: all|active|paused|error|builtin), once per mount.
 *
 * The programme's "126 capturable surfaces" headline is testable against this
 * output: it matches static(67) + dynamic(47) + splat(6) + app-level(6) only if
 * every dynamic and splat path is counted as independently "capturable", which
 * requires entities no default install seeds. The honest denominator for a
 * capture run is the static set plus however many dynamic routes the run's own
 * seed makes reachable.
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../../ui/src/App.tsx', import.meta.url), 'utf8');

const REDIRECT_COMPONENTS = new Set([
  'Navigate', 'UnprefixedBoardRedirect', 'LegacySettingsRedirect',
  'LegacyToolsRedirect', 'LegacyToolsSettingsRedirect', 'LegacyTrainingRedirect',
  'LegacySkillStudioRedirect', 'StatusCardsLegacyRedirect', 'InboxRootRedirect',
  'PipelineItemLegacyRedirect', 'CompanyRootRedirect', 'CompanyAccessLegacyRoute'
]);

// Every <Route ...> tag, across line breaks, non-greedy to the closing '>'.
const tags = src.match(/<Route\b[\s\S]*?>/g) || [];
const routes = [];
for (const tag of tags) {
  const path = /path=\{?[`"']([^`"']*)[`"']\}?/.exec(tag)?.[1];
  const index = /\bindex\b/.test(tag) && path === undefined;
  const el = /element=\{<([A-Za-z0-9_.]+)/.exec(tag)?.[1] ?? null;
  const devOnly = false; // patched below by scanning the two DEV blocks
  routes.push({ path: path ?? (index ? '(index)' : '(layout)'), el, tag, devOnly });
}

// DEV-gated blocks: `import.meta.env.DEV ? ( ... ) : null`
for (const m of src.matchAll(/import\.meta\.env\.DEV \? \(([\s\S]*?)\) : null/g)) {
  for (const t of m[1].match(/<Route\b[\s\S]*?>/g) || []) {
    const p = /path=\{?[`"']([^`"']*)[`"']\}?/.exec(t)?.[1];
    for (const r of routes) if (r.path === p && r.tag === t) r.devOnly = true;
  }
}

const AGENT_FILTER_TABS = ['all', 'active', 'paused', 'error', 'builtin'];

function classify(r) {
  if (r.path === '(layout)' || r.path === '(index)') return r.el && REDIRECT_COMPONENTS.has(r.el) ? 'redirect' : 'structural';
  if (r.el && REDIRECT_COMPONENTS.has(r.el)) return 'redirect';
  if (r.path.includes('*')) return 'splat';
  if (r.path.includes(':')) return 'dynamic';
  return 'static';
}

const counts = {};
const staticPaths = [];
for (const r of routes) {
  // expand the template route `agents/${tab}` — appears twice (board + unprefixed)
  if (r.path === 'agents/${tab}') {
    const cls = r.el && REDIRECT_COMPONENTS.has(r.el) ? 'redirect' : 'static';
    counts[cls] = (counts[cls] || 0) + AGENT_FILTER_TABS.length;
    if (cls === 'static') for (const t of AGENT_FILTER_TABS) staticPaths.push({ path: `agents/${t}`, el: r.el, devOnly: r.devOnly });
    continue;
  }
  const cls = classify(r);
  counts[cls] = (counts[cls] || 0) + 1;
  if (cls === 'static') staticPaths.push({ path: r.path, el: r.el, devOnly: r.devOnly });
}

console.log('route tags found:', tags.length, '(agents/${tab} counted once per mount here)');
console.log('classification:', counts);
console.log('\nstatic, non-redirect paths (devOnly flagged):');
for (const s of staticPaths.sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`  ${s.devOnly ? '[DEV-ONLY] ' : ''}${s.path}  ->  ${s.el}`);
}
console.log('\nstatic total:', staticPaths.length,
  '| production-reachable static:', staticPaths.filter((s) => !s.devOnly).length);
