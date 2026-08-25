/**
 * Record what was actually running when the captures were taken.
 *
 * The build-currency block is the part that matters. "Evidence must postdate
 * the code" is not satisfied by a server that reports a commit — this server
 * reads git at request time, so it reports whatever HEAD says regardless of
 * when its bundle was built. The check that means something is whether any
 * commit or working-tree change touched `ui/` after the bundle's build
 * timestamp, and that is what is recorded here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DIST = path.join(REPO, 'ui', 'dist');
const sh = (c) => execSync(c, { cwd: REPO }).toString().trim();

const BASE = process.env.BASE || 'http://127.0.0.1:3197';
const health = await (await fetch(BASE + '/api/health')).json().catch(() => ({}));

const distStat = fs.statSync(path.join(DIST, 'index.html'));
const builtAt = distStat.mtime.toISOString();
const remoteTip = sh('git rev-parse origin/dev');

// Did ui/ change after the bundle was built, anywhere that matters?
const uiCommitsAfterBuild = sh(`git log --since="${builtAt}" --format=%h -- ui/`);
const uiWorktreeDirty = sh('git status --porcelain -- ui/');
const uiSameAtRemoteTip = (() => {
  try { execSync(`git diff --quiet ${remoteTip} -- ui/`, { cwd: REPO }); return true; }
  catch { return false; }
})();

const assets = fs.readdirSync(path.join(DIST, 'assets'));
const size = (f) => fs.statSync(path.join(DIST, 'assets', f)).size;
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));
const largestJs = js.slice().sort((a, b) => size(b) - size(a))[0];

const provenance = {
  recordedAt: new Date().toISOString(),
  capturedBy: 'docs/uiux/browser-evidence-2026-08-25/capture.mjs',
  server: {
    base: BASE,
    deploymentMode: health.deploymentMode ?? null,
    deploymentExposure: health.deploymentExposure ?? null,
    serverVersion: health.serverVersion ?? null,
    processStartedAt: health.serverInfo?.processStartedAt ?? null,
    serves: 'the production ui/dist bundle (no vite dev middleware)',
    seed: 'isolated instance seeded with a fictional company; NOT the operator instance',
    database: 'embedded PostgreSQL, throwaway PAPERCLIP_HOME'
  },
  code: {
    remoteTip,
    remoteTipSubject: sh(`git log -1 --format=%s ${remoteTip}`),
    remoteTipCommittedAt: sh(`git log -1 --format=%cI ${remoteTip}`),
    note:
      'The local branch pointer in this shared checkout is not a reliable ' +
      'identity for the code under test - another session moved it during ' +
      'this run. origin/dev is the identity used here, and the ui/ tree is ' +
      'proven identical to it below.'
  },
  buildCurrency: {
    uiDistBuiltAt: builtAt,
    uiCommitsAfterBuild: uiCommitsAfterBuild ? uiCommitsAfterBuild.split('\n') : [],
    uiWorktreeDirty: uiWorktreeDirty ? uiWorktreeDirty.split('\n') : [],
    uiTreeIdenticalToRemoteTip: uiSameAtRemoteTip,
    verdict:
      uiCommitsAfterBuild === '' && uiWorktreeDirty === '' && uiSameAtRemoteTip
        ? 'CURRENT: no commit and no working-tree change touched ui/ after the bundle was built, and the ui/ tree is byte-identical to origin/dev. The captured bundle is the code at origin/dev.'
        : 'STALE: ui/ changed after the build; the capture does not describe origin/dev.'
  },
  bundle: {
    jsFileCount: js.length,
    jsTotalBytes: js.reduce((a, f) => a + size(f), 0),
    largestJsChunk: largestJs ? { file: largestJs, bytes: size(largestJs) } : null,
    cssChunks: css.map((f) => ({ file: f, bytes: size(f) })),
    selfHostedFonts: fs.existsSync(path.join(DIST, 'fonts'))
      ? fs.readdirSync(path.join(DIST, 'fonts')).filter((f) => f.endsWith('.woff2'))
      : []
  },
  tooling: {
    playwright: 'playwright 1.62.1, chromium_headless_shell (repo node_modules)',
    routeDerivation: 'react-router-adapter.mjs against ui/src/App.tsx'
  }
};

const out = path.join(HERE, 'provenance.json');
fs.writeFileSync(out, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance.buildCurrency, null, 2));
console.log('largest JS chunk:', JSON.stringify(provenance.bundle.largestJsChunk));
