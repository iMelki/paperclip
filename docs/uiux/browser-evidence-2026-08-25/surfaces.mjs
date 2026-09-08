/**
 * Paperclip capturable-surface list, derived from ui/src/App.tsx at the commit
 * under test — NOT copied from any prior figure — with every `expect` string
 * taken from the discovery pass (discover.mjs -> discovery.json) run against
 * the seeded fixture, so each assertion binds to text that surface actually
 * renders in <main> (or its visible body for the three surfaces that render
 * outside <main>).
 *
 * Rules for `expect`, and the reasons:
 *   1. NEVER sidebar/chrome text. Paperclip renders a persistent left sidebar
 *      on every board route; asserting "Projects" on /projects asserts
 *      nothing. The runner captures chrome text once and reports collisions;
 *      the content gate itself only reads non-chrome text.
 *   2. NEVER "Command Palette". The cmdk dialog title exists hidden in the DOM
 *      of every route, so it is the chrome-equivalent inside <main>. The gate
 *      reads innerText (visible only) specifically to keep hidden dialog text
 *      from satisfying an assertion.
 *   3. Prefer SEEDED fixture strings (an issue title, a project description),
 *      which cannot be a skeleton and cannot be chrome; else the surface's own
 *      empty-state or explainer copy as measured by discovery.
 *
 * Route derivation at this commit (see derive-routes.mjs): 211 <Route> tags —
 * 71 static (68 production-reachable after DEV-only), 47 dynamic, 6 splat,
 * 91 redirect, 4 structural. The programme's "126 capturable surfaces"
 * headline counts every dynamic and splat path as independently capturable,
 * which no default install's data supports. The honest enumerable set for
 * this run is below: 60 static + 8 seeded-dynamic + 6 app-level = 74, after
 * moving two routes discovery PROVED are redirects at this commit into
 * KNOWN_REDIRECTS.
 */

export const PREFIX = 'NOR';

/**
 * Routes the first sweep counted as capturable static surfaces that discovery
 * proved redirect at this commit. Excluded from the denominator; recorded here
 * so the next derivation does not silently re-add them.
 */
export const KNOWN_REDIRECTS = [
  { id: 'workspaces', path: '/workspaces', redirectsTo: '/issues' },
  { id: 'apps-connect', path: '/apps/connect', redirectsTo: '/apps' }
];

export const STATIC_SURFACES = [
  // --- core board
  { id: 'dashboard', path: '/dashboard', expect: 'Recovery needed' },
  { id: 'dashboard-live', path: '/dashboard/live', expect: 'Live agent runs' },
  { id: 'timeline', path: '/timeline', expect: 'Work Timeline' },
  { id: 'companies', path: '/companies', expect: 'Fictional home-robotics company' },
  { id: 'org', path: '/org', expect: 'Export company' },
  { id: 'search', path: '/search', expect: 'Type to search company memory' },
  { id: 'design-guide', path: '/design-guide', expect: 'Every component, style, and pattern' },

  // --- work
  { id: 'issues', path: '/issues', expect: 'Grasp planner drops slippery utensils' },
  { id: 'projects', path: '/projects', expect: 'Dish handling, counter wiping' },
  { id: 'routines', path: '/routines', expect: 'Recurring work definitions' },
  { id: 'goals', path: '/goals', expect: 'Ship the v3 home robot' },
  { id: 'artifacts', path: '/artifacts', expect: 'No artifact stacks yet' },
  { id: 'costs', path: '/costs', expect: 'Inference spend, platform fees' },
  { id: 'activity', path: '/activity', expect: 'Everything happening in your company' },
  { id: 'approvals-pending', path: '/approvals/pending', expect: 'No pending approvals' },
  { id: 'approvals-all', path: '/approvals/all', expect: 'No approvals yet' },

  // --- agents
  { id: 'agents-all', path: '/agents/all', expect: 'Priya Raman' },
  { id: 'agents-active', path: '/agents/active', expect: 'No agents match the selected status' },
  { id: 'agents-paused', path: '/agents/paused', expect: 'Reflection Coach' },
  { id: 'agents-error', path: '/agents/error', expect: 'Chief Technology Officer' },
  { id: 'agents-builtin', path: '/agents/builtin', expect: 'Summarizer' },
  { id: 'agents-new', path: '/agents/new', expect: 'Advanced agent configuration' },

  // --- inbox (seeded issue NOR-5 appears across tabs)
  { id: 'inbox-mine', path: '/inbox/mine', expect: 'Battery dock alignment drifts' },
  { id: 'inbox-recent', path: '/inbox/recent', expect: 'Battery dock alignment drifts' },
  { id: 'inbox-unread', path: '/inbox/unread', expect: 'Battery dock alignment drifts' },
  { id: 'inbox-blocked', path: '/inbox/blocked', expect: 'Battery dock alignment drifts' },
  { id: 'inbox-all', path: '/inbox/all', expect: 'All categories' },
  { id: 'inbox-requests', path: '/inbox/requests', expect: 'Join Request Queue' },

  // --- experimental-flag surfaces (flags enabled for this run; see README)
  { id: 'cases', path: '/cases', expect: 'No cases yet' },
  { id: 'status', path: '/status', expect: 'No status cards yet' },
  { id: 'review-queue', path: '/review-queue', expect: 'Nothing needs you right now' },
  { id: 'learnings', path: '/learnings', expect: 'Patterns from review decisions' },
  { id: 'pipelines', path: '/pipelines', expect: 'Pipeline' },
  { id: 'decisions', path: '/decisions', expect: 'Decision' },
  { id: 'decisions-training', path: '/decisions/training', expect: 'Human decision traces' },
  { id: 'board-chat', path: '/board-chat', expect: 'Live activity from your agents' },

  // --- apps (AppsExperimentalGate)
  { id: 'apps', path: '/apps', expect: 'connect your own MCP server' },
  { id: 'apps-connections', path: '/apps/connections', expect: 'No connections yet' },
  { id: 'apps-review', path: '/apps/review', expect: 'Actions your agents want to run' },
  { id: 'apps-gateways', path: '/apps/gateways', expect: 'one safe MCP endpoint' },
  { id: 'apps-advanced', path: '/apps/advanced', expect: "aren't in the gallery" },
  { id: 'apps-profile-new', path: '/apps/advanced/profiles/new', expect: 'Choose which tools this profile allows' },

  // --- skills
  { id: 'skills-studio', path: '/skills/studio', expect: 'Recently updated' },
  { id: 'skills-studio-new', path: '/skills/studio/new', expect: 'Create an editable company skill' },

  // --- company settings
  { id: 'company-settings', path: '/company/settings', expect: 'Require board approval' },
  { id: 'company-members', path: '/company/settings/members', expect: 'Manage the people who can work' },
  { id: 'company-invites', path: '/company/settings/invites', expect: 'Invite people to request access' },
  { id: 'company-import', path: '/company/import', expect: 'upload a local Paperclip zip' },
  { id: 'company-secrets', path: '/company/settings/secrets', expect: 'binding them to runtime environment variables' },

  // --- instance settings
  { id: 'inst-profile', path: '/company/settings/instance/profile', expect: 'Control how your account appears' },
  { id: 'inst-general', path: '/company/settings/instance/general', expect: 'Configure instance-wide preferences' },
  { id: 'inst-environments', path: '/company/settings/instance/environments', expect: 'Default execution environment' },
  { id: 'inst-environments-new', path: '/company/settings/instance/environments/new', expect: 'Configure a reusable execution target' },
  { id: 'inst-access', path: '/company/settings/instance/access', expect: 'manage instance-admin status' },
  { id: 'inst-heartbeats', path: '/company/settings/instance/heartbeats', expect: 'timer heartbeat enabled' },
  { id: 'inst-experimental', path: '/company/settings/instance/experimental', expect: 'still being evaluated' },
  { id: 'inst-plugins', path: '/company/settings/instance/plugins', expect: 'plugin runtime and API surface' },
  { id: 'inst-adapters', path: '/company/settings/instance/adapters', expect: 'External adapters are alpha' },
  { id: 'instance-adapters-alt', path: '/instance/settings/adapters', expect: 'External adapters are alpha' },

  // --- onboarding (renders outside <main>; visible-body fallback applies)
  { id: 'onboarding', path: '/onboarding', expect: 'Name your company' }
];

/**
 * App-level statics — NOT under /:companyPrefix. `unprefixed: true` means the
 * runner must not prepend the company prefix.
 *
 * `auth` is EXPECTED to be unreachable in this run's local_trusted deployment
 * mode: /auth redirects straight to the board dashboard, so its outcome is
 * NO-CONTENT by design and it stays in the denominator as a stated gap.
 */
export const APP_SURFACES = [
  { id: 'auth', path: '/auth', expect: 'Sign in', unprefixed: true, expectedUnreachable: 'local_trusted auto-redirects /auth to the board' },
  { id: 'ux-lab-bootstrap', path: '/ux-lab/bootstrap-setup', expect: 'Finish setting up this Paperclip', unprefixed: true },
  { id: 'ux-lab-denial', path: '/ux-lab/responsible-user-denial', expect: 'responsible user not authorized', unprefixed: true },
  { id: 'ux-lab-crossissue', path: '/ux-lab/cross-issue-collaboration', expect: 'cross-task collaboration', unprefixed: true },
  { id: 'perf-long-thread', path: '/tests/perf/long-thread', expect: 'Long-thread rendering baseline fixture', unprefixed: true },
  { id: 'notfound', path: '/this-route-does-not-exist-xyz', expect: 'No company matches prefix', unprefixed: true }
];

/**
 * Dynamic (:param) surfaces, reachable only because this run seeded real
 * entities. IDs are injected by the runner from the live API, so this list
 * carries no hardcoded UUIDs. Note: at this commit /projects/:id redirects to
 * its /issues tab and /projects/:id/workspaces redirects to /issues when
 * isolated workspaces are off — the runner records `redirected` per surface
 * and the summary counts DISTINCT final paths.
 */
export function dynamicSurfaces(ids) {
  const out = [];
  if (ids.issueId) {
    out.push({ id: 'issue-detail', path: `/issues/${ids.issueId}`, expect: 'Arm stalls when the dish rack is over-filled' });
  }
  if (ids.projectId) {
    out.push(
      { id: 'project-detail', path: `/projects/${ids.projectId}`, expect: 'Project summary' },
      { id: 'project-issues', path: `/projects/${ids.projectId}/issues`, expect: 'Project summary' },
      { id: 'project-workspaces', path: `/projects/${ids.projectId}/workspaces`, expect: 'Project summary' },
      { id: 'project-config', path: `/projects/${ids.projectId}/configuration`, expect: 'Project summary' },
      { id: 'project-budget', path: `/projects/${ids.projectId}/budget`, expect: 'Project summary' }
    );
  }
  if (ids.agentId) {
    out.push({ id: 'agent-detail', path: `/agents/${ids.agentId}`, expect: 'Chief Technology Officer' });
  }
  if (ids.goalId) {
    out.push({ id: 'goal-detail', path: `/goals/${ids.goalId}`, expect: 'Retail launch gate' });
  }
  return out;
}
