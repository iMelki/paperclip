/**
 * Seed the FICTIONAL "Northwind Robotics" fixture into an ISOLATED paperclip
 * instance (never the operator's real instance) so dynamic routes are reachable
 * and content assertions can bind to seeded data instead of chrome.
 *
 * Usage:  BASE=http://127.0.0.1:3197 node seed.mjs
 *
 * The fixture is fiction on purpose: captures of these surfaces land in a
 * tracked repo, so no real company/operator data may appear in them. The
 * instance is expected to be booted with its own PAPERCLIP_HOME (fresh
 * embedded postgres) — this script REFUSES to run against an instance that
 * already has companies it did not create.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3197';

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

const existing = await api('GET', '/api/companies');
const mine = existing.find((c) => c.name === 'Northwind Robotics');
if (existing.length > 0 && !mine) {
  console.error('REFUSING: instance already has companies not created by this seed:',
    existing.map((c) => c.name));
  process.exit(2);
}

const company = mine ?? await api('POST', '/api/companies', {
  name: 'Northwind Robotics',
  description: 'Fictional home-robotics company used as the capture fixture for UI/UX evidence runs.'
});
console.log('company', company.id, 'prefix', company.issuePrefix);
const cid = company.id;

async function ensureAgent(name, role, title, capabilities) {
  const agents = await api('GET', `/api/companies/${cid}/agents`);
  const hit = (agents || []).find((a) => a.name === name);
  if (hit) return hit;
  return api('POST', `/api/companies/${cid}/agents`, { name, role, title, capabilities });
}
const ada = await ensureAgent('Ada Chen', 'cto', 'Chief Technology Officer',
  'Owns the robotics platform architecture and firmware release train.');
const leo = await ensureAgent('Leo Fontaine', 'engineer', 'Senior Manipulation Engineer',
  'Grasp planning, arm control loops, dish-handling edge cases.');
const marcus = await ensureAgent('Marcus Webb', 'devops', 'Fleet Reliability Engineer',
  'Owns OTA rollouts and fleet telemetry pipelines.');
const priya = await ensureAgent('Priya Raman', 'designer', 'Product Design Lead',
  'Owner UX for the companion app and on-robot touchscreen.');
console.log('agents', [ada, leo, marcus, priya].map((a) => a.name).join(', '));

const goals = await api('GET', `/api/companies/${cid}/goals`);
const goal = (goals || []).find((g) => /Ship the v3/.test(g.title)) ??
  await api('POST', `/api/companies/${cid}/goals`, {
    title: 'Ship the v3 home robot to 5,000 retail units',
    description: 'Retail launch gate: manipulation reliability at 99.2%, sub-45-minute unboxing, fleet OTA channel live.',
    level: 'company', status: 'active', ownerAgentId: ada.id
  });
console.log('goal', goal.title);

const projects = await api('GET', `/api/companies/${cid}/projects`);
const project = (projects || []).find((p) => p.name === 'Kitchen Autonomy') ??
  await api('POST', `/api/companies/${cid}/projects`, {
    name: 'Kitchen Autonomy',
    description: 'Dish handling, counter wiping, and appliance interaction for the v3 launch.',
    status: 'in_progress', goalId: goal.id, leadAgentId: ada.id, icon: 'rocket'
  });
console.log('project', project.name);

const ISSUES = [
  { title: 'Arm stalls when the dish rack is over-filled', status: 'in_progress', priority: 'high',
    description: 'Reproducible when more than 14 plates are racked; torque limiter trips and the grasp planner never retries.',
    assigneeAgentId: leo.id, projectId: project.id },
  { title: 'Counter-wipe path planner misses corners on L-shaped counters', status: 'todo', priority: 'medium',
    description: 'Coverage map shows 6% missed area on L-shaped test kitchens.', assigneeAgentId: leo.id, projectId: project.id },
  { title: 'OTA rollout pauses at 40% on fleets behind strict proxies', status: 'blocked', priority: 'critical',
    description: 'Delta bundles fail checksum behind TLS-intercepting proxies; needs a resumable channel.', assigneeAgentId: marcus.id, projectId: project.id },
  { title: 'Touchscreen onboarding flow skips Wi-Fi credentials on retry', status: 'in_review', priority: 'high',
    description: 'Second attempt after a mistyped password jumps straight to the tour.', assigneeAgentId: priya.id, projectId: project.id },
  { title: 'Battery dock alignment drifts after firmware 3.4.1', status: 'todo', priority: 'high',
    description: 'Dock alignment error doubled in the 3.4.1 cohort telemetry.', assigneeAgentId: marcus.id, projectId: project.id },
  { title: 'Quiet-hours vacuum schedule ignores timezone changes', status: 'backlog', priority: 'low',
    description: 'Robots that travel across timezones keep the old quiet-hours window.', projectId: project.id },
  { title: 'Companion app push notifications duplicated on Android 15', status: 'done', priority: 'medium',
    description: 'Fixed by de-duplicating on notification channel id.', assigneeAgentId: priya.id, projectId: project.id },
  { title: 'Grasp planner drops slippery utensils in humid kitchens', status: 'todo', priority: 'medium',
    description: 'Humidity sensor feed is not wired into grip-force selection.', assigneeAgentId: leo.id, projectId: project.id, goalId: goal.id }
];
const existingIssues = await api('GET', `/api/companies/${cid}/issues`);
for (const spec of ISSUES) {
  if ((existingIssues || []).some((i) => i.title === spec.title)) continue;
  const made = await api('POST', `/api/companies/${cid}/issues`, spec);
  console.log('issue', made.issueKey ?? made.key ?? made.id, spec.title.slice(0, 40));
}

console.log('SEED COMPLETE. prefix =', company.issuePrefix);
