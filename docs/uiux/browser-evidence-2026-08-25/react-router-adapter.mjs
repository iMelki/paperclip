/**
 * React Router surface adapter for paperclip's UI.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every prior round derived this app's capturable surfaces with an App-Router
 * (file-system) deriver. Paperclip is not a Next app: it is a Vite SPA whose
 * entire surface map is a nested `<Route>` JSX tree in ui/src/App.tsx. A
 * file-system deriver sees `ui/src/pages/*.tsx` — component files, not routes —
 * so it produced a surface list that matched no URL the server would serve.
 *
 * WHAT IT DOES
 * ------------
 * Parses ui/src/App.tsx into the real nested route tree and emits FULL paths:
 *
 *   1. Angle/brace/quote-aware tag scanner. A naive /<Route[\s\S]*?>/ regex
 *      terminates inside `element={<Navigate to="/x" replace />}`, silently
 *      truncating the tag and losing its element name. This scanner ends a tag
 *      only at a '>' seen at brace-depth 0 outside quotes.
 *   2. Nesting. `<Route path="a">` ... `</Route>` contributes 'a' to every
 *      descendant's path; a pathless `<Route element={<Gate/>}>` contributes
 *      nothing but still opens a scope.
 *   3. Out-of-line fragments. `boardRoutes()` is a function returning a
 *      fragment of ~150 routes, defined ABOVE the <Routes> tree and spliced in
 *      under `<Route path=":companyPrefix">`. A linear scan attributes those
 *      routes to the wrong parent (or to no parent) and loses the company
 *      prefix from every board URL. The adapter parses the fragment separately
 *      and splices it at its call site.
 *   4. Template expansion. Route paths written as a template literal over
 *      AGENT_FILTER_TABS are expanded against the real list in
 *      ui/src/pages/Agents.tsx.
 *   5. DEV gating. Routes inside `import.meta.env.DEV ? ( ... ) : null` do not
 *      exist in the production bundle the server ships and are excluded from
 *      the capturable denominator (flagged, not deleted).
 *
 * CLASSIFICATION (mutually exclusive, in this order)
 *   layout    — no path of its own (a wrapper/gate)
 *   redirect  — element is <Navigate> or a *Redirect / legacy-route component
 *   splat     — path contains '*'
 *   dynamic   — path contains ':' other than the :companyPrefix mount itself
 *   static    — everything else  -> the capturable set
 *
 * Only `static` is capturable without seeded entities. `dynamic` is capturable
 * only for the ids a given instance actually holds, which is why the runner
 * resolves them from the live API at run time and reports how many it got.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(HERE, '../../../ui/src/App.tsx');
const AGENTS_TSX = path.resolve(HERE, '../../../ui/src/pages/Agents.tsx');

const REDIRECT_ELEMENTS = new Set([
  'Navigate',
  'UnprefixedBoardRedirect',
  'LegacySettingsRedirect',
  'LegacyToolsRedirect',
  'LegacyToolsSettingsRedirect',
  'LegacyTrainingRedirect',
  'LegacySkillStudioRedirect',
  'StatusCardsLegacyRedirect',
  'InboxRootRedirect',
  'PipelineItemLegacyRedirect',
  'CompanyRootRedirect',
  'CompanyAccessLegacyRoute'
]);

/** Scan one JSX tag starting at '<'; returns {end, selfClosing, body}. */
function scanTag(src, start) {
  let i = start + 1;
  let depth = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (c === '>' && depth === 0) {
      const selfClosing = src[i - 1] === '/';
      return { end: i + 1, selfClosing, body: src.slice(start, i + 1) };
    }
    i++;
  }
  return null;
}

const attrPath = (tag) => /\bpath=\{?[`"']([^`"']*)[`"']\}?/.exec(tag)?.[1] ?? null;
const attrElement = (tag) => /\belement=\{\s*<([A-Za-z0-9_.]+)/.exec(tag)?.[1] ?? null;
const isIndex = (tag) => /\bindex\b(?!=)/.test(tag);

/** Byte ranges of `import.meta.env.DEV ? ( ... ) : null` blocks. */
function devRanges(src) {
  const out = [];
  for (const m of src.matchAll(/import\.meta\.env\.DEV\s*\?/g)) {
    const open = src.indexOf('(', m.index + m[0].length);
    if (open < 0) continue;
    let d = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') { d--; if (d === 0) { out.push([open, i]); break; } }
    }
  }
  return out;
}

/**
 * Parse a region of source into route records with parent paths joined.
 * `splices` maps a call expression (e.g. the boardRoutes() call) to a
 * sub-parser that expands it under the current parent path.
 */
function parseRegion(src, from, to, basePath, dev, splices, out) {
  const stack = [{ path: basePath }];
  let i = from;
  while (i < to) {
    const nextOpen = src.indexOf('<Route', i);
    const nextClose = src.indexOf('</Route>', i);
    const spliceHit = splices
      .map((s) => ({ s, at: src.indexOf(s.token, i) }))
      .filter((h) => h.at >= 0 && h.at < to)
      .sort((a, b) => a.at - b.at)[0];

    const candidates = [
      nextOpen >= 0 && nextOpen < to ? { kind: 'open', at: nextOpen } : null,
      nextClose >= 0 && nextClose < to ? { kind: 'close', at: nextClose } : null,
      spliceHit ? { kind: 'splice', at: spliceHit.at, s: spliceHit.s } : null
    ].filter(Boolean).sort((a, b) => a.at - b.at);
    if (!candidates.length) break;
    const nxt = candidates[0];

    if (nxt.kind === 'close') { if (stack.length > 1) stack.pop(); i = nxt.at + 8; continue; }
    if (nxt.kind === 'splice') {
      nxt.s.expand(stack[stack.length - 1].path, out);
      i = nxt.at + nxt.s.token.length;
      continue;
    }

    const tag = scanTag(src, nxt.at);
    if (!tag) break;
    const rel = attrPath(tag.body);
    const el = attrElement(tag.body);
    const parent = stack[stack.length - 1].path;
    const devOnly = dev.some(([a, b]) => nxt.at > a && nxt.at < b);
    const joined = rel === null
      ? parent
      : (parent === '' ? '/' + rel : parent.replace(/\/$/, '') + '/' + rel);
    const full = (rel === null && !isIndex(tag.body) ? parent : joined).replace(/\/+/g, '/');

    out.push({
      rel: rel ?? (isIndex(tag.body) ? '(index)' : '(layout)'),
      full,
      element: el,
      hasPath: rel !== null,
      index: isIndex(tag.body) && rel === null,
      // A tag that opens a scope wraps children: it is a MOUNT, not a leaf
      // surface. `<Route path=":companyPrefix" element={<Layout/>}>` is the
      // whole board mount; counting it as a capturable surface would put a
      // bare `/PREFIX` in the denominator, which only ever redirects.
      wrapsChildren: !tag.selfClosing,
      devOnly
    });

    if (!tag.selfClosing) stack.push({ path: rel === null ? parent : full });
    i = tag.end;
  }
}

function boardFragmentRange(src) {
  const fnAt = src.indexOf('function boardRoutes()');
  if (fnAt < 0) throw new Error('boardRoutes() not found - adapter assumption broken');
  const open = src.indexOf('{', fnAt);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return [open, i]; }
  }
  throw new Error('boardRoutes() body unterminated');
}

export function deriveRoutes() {
  const src = fs.readFileSync(APP_TSX, 'utf8');
  const dev = devRanges(src);

  const tabsSrc = fs.readFileSync(AGENTS_TSX, 'utf8');
  const tabsMatch = /AGENT_FILTER_TABS\s*=\s*\[([^\]]+)\]/.exec(tabsSrc);
  const AGENT_FILTER_TABS = tabsMatch
    ? tabsMatch[1].split(',').map((t) => t.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
    : ['all', 'active', 'paused', 'error', 'builtin'];

  const [bFrom, bTo] = boardFragmentRange(src);
  const boardSplice = {
    token: '{boardRoutes()}',
    expand: (parentPath, out) => parseRegion(src, bFrom, bTo, parentPath, dev, [], out)
  };

  const routesAt = src.indexOf('<Routes>');
  const routesEnd = src.indexOf('</Routes>');
  if (routesAt < 0 || routesEnd < 0) throw new Error('<Routes> tree not found');

  const raw = [];
  parseRegion(src, routesAt + 8, routesEnd, '', dev, [boardSplice], raw);

  // expand the AGENT_FILTER_TABS template route
  const TEMPLATE = 'agents/${tab}';
  const routes = [];
  for (const r of raw) {
    if (r.rel === TEMPLATE) {
      for (const t of AGENT_FILTER_TABS) {
        routes.push({ ...r, rel: 'agents/' + t, full: r.full.split(TEMPLATE).join('agents/' + t) });
      }
      continue;
    }
    routes.push(r);
  }

  for (const r of routes) {
    if (!r.hasPath && !r.index) r.kind = 'layout';
    else if (r.element && REDIRECT_ELEMENTS.has(r.element)) r.kind = 'redirect';
    else if (r.full.includes('*')) r.kind = 'splat';
    else if (/:[A-Za-z]/.test(r.full.split(':companyPrefix').join(''))) r.kind = 'dynamic';
    else r.kind = 'static';
  }

  const counts = {};
  for (const r of routes) counts[r.kind] = (counts[r.kind] || 0) + 1;

  // Capturable static set: production-only, de-duplicated by full path.
  const seen = new Set();
  const capturableStatic = [];
  for (const r of routes) {
    if (r.kind !== 'static' || r.devOnly || r.wrapsChildren) continue;
    if (seen.has(r.full)) continue;
    seen.add(r.full);
    capturableStatic.push(r);
  }

  const dynSeen = new Set();
  const dynamic = [];
  for (const r of routes) {
    if (r.kind !== 'dynamic' || r.devOnly) continue;
    if (dynSeen.has(r.full)) continue;
    dynSeen.add(r.full);
    dynamic.push(r);
  }

  return { routes, counts, capturableStatic, dynamic, agentFilterTabs: AGENT_FILTER_TABS, appTsx: APP_TSX };
}

/** Turn a derived route into a concrete URL path for a given company prefix. */
export function toUrl(full, prefix, params = {}) {
  let p = full.split(':companyPrefix').join(prefix);
  for (const [k, v] of Object.entries(params)) p = p.split(':' + k).join(v);
  return p;
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (invokedDirectly) {
  const d = deriveRoutes();
  console.log('parsed <Route> records:', d.routes.length);
  console.log('classification:', JSON.stringify(d.counts));
  console.log('AGENT_FILTER_TABS:', d.agentFilterTabs.join(','));
  console.log('capturable static (production, de-duped):', d.capturableStatic.length);
  console.log('distinct dynamic patterns (production):', d.dynamic.length);
  if (process.env.LIST === '1') {
    for (const r of d.capturableStatic) console.log('  S ' + r.full + '  -> ' + r.element);
    for (const r of d.dynamic) console.log('  D ' + r.full + '  -> ' + r.element);
  }
}
