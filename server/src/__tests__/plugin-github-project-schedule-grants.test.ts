import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// In-memory stand-in for the plugin state table: no database is opened.
const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => ({
    get: async (pluginId: string, kind: string, key: string, options: { scopeId?: string; namespace?: string } = {}) =>
      stored.get([pluginId, kind, options.scopeId, options.namespace, key].join("|")) ?? null,
  }),
}));

import { GITHUB_PROJECT_BINDING_NAMESPACE } from "../services/plugin-github-project-board.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY, GITHUB_PROJECT_GRANT_MAX_AGE_MS, scheduleGrantSchema,
  type GitHubProjectScheduleGrant } from "../services/github-project-schedule-grant-contract.js";
import { matchesNativeScheduleGrantSnapshot, readRetainedNativeScheduleGrant } from "../services/plugin-github-project-schedule-grants.js";
import { selectNativeBoardJobTargets } from "../services/github-project-board-job-targets.js";
import { boardImportDigest } from "../services/plugin-imported-issues-contract.js";

const PLUGIN = "10000000-0000-4000-8000-000000000001";
const COMPANY = "20000000-0000-4000-8000-000000000002";
const PROJECT = "30000000-0000-4000-8000-000000000003";
const JOB = "40000000-0000-4000-8000-000000000004";
const OTHER = "50000000-0000-4000-8000-000000000005";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const binding = { boardId: "PVT_board", boardUrl: "https://github.com/orgs/example/projects/1", connectionId: OTHER,
  accountId: 1001, login: "synthetic" };
const AUTH = "a".repeat(64);

function grant(overrides: Record<string, unknown> = {}) {
  return { companyId: COMPANY, projectId: PROJECT, version: 1, pluginId: PLUGIN, grantId: OTHER, revision: 1, jobId: JOB,
    jobKey: GITHUB_PROJECT_BOARD_JOB_KEY, enabled: true, maxItems: 20, ...binding,
    bindingDigest: boardImportDigest(binding), authorizationDigest: AUTH, grantedByUserId: "user-1",
    grantedAt: iso(NOW), expiresAt: iso(NOW + GITHUB_PROJECT_GRANT_MAX_AGE_MS), revokedAt: null, revokedByUserId: null,
    importOnly: true, noDispatch: true, ...overrides } as GitHubProjectScheduleGrant;
}
const row = (value: unknown, overrides: Partial<{ scopeId: string; stateKey: string }> = {}) => ({
  scopeId: COMPANY, stateKey: `schedule-grant:${PROJECT}`, valueJson: value as never, ...overrides });
const select = (rows: ReturnType<typeof row>[], company?: string, now = NOW) =>
  selectNativeBoardJobTargets(rows, PLUGIN, JOB, company, now);

describe("schedule grant lifetime", () => {
  it("accepts exactly the 24 hour cap", () => {
    expect(scheduleGrantSchema.safeParse(grant()).success).toBe(true);
  });
  it("refuses one millisecond over the cap", () => {
    expect(scheduleGrantSchema.safeParse(grant({ expiresAt: iso(NOW + GITHUB_PROJECT_GRANT_MAX_AGE_MS + 1) })).success).toBe(false);
  });
  it.each([["equal to", 0], ["before", -1000]])("refuses an expiry %s the grant time", (_label, delta) => {
    expect(scheduleGrantSchema.safeParse(grant({ expiresAt: iso(NOW + delta) })).success).toBe(false);
  });
  it("does not count an expired grant as active (exactly at expiry and later)", () => {
    const value = grant();
    const expiresAt = Date.parse(value.expiresAt);
    expect(select([row(value)], undefined, expiresAt - 1)).toHaveLength(1);
    expect(select([row(value)], undefined, expiresAt)).toEqual([]);
    expect(select([row(value)], undefined, expiresAt + 1)).toEqual([]);
  });
});

describe("schedule grant scope equality and invariants", () => {
  it.each([
    ["importOnly false", { importOnly: false }],
    ["noDispatch false", { noDispatch: false }],
    ["maxItems zero", { maxItems: 0 }],
    ["maxItems above twenty", { maxItems: 21 }],
    ["a repository job key", { jobKey: "sync.github-repository" }],
    ["a non-uuid company", { companyId: "company-1" }],
    ["a non-uuid project", { projectId: "project-1" }],
    ["an extra field", { extra: true }],
    ["revoked but still enabled", { revokedAt: iso(NOW + 1000), revokedByUserId: "user-1", enabled: true }],
    ["revoked without a revoking user", { revokedAt: iso(NOW + 1000), revokedByUserId: null, enabled: false }],
  ])("refuses %s", (_label, overrides) => {
    expect(scheduleGrantSchema.safeParse(grant(overrides)).success).toBe(false);
  });

  const snapshot = () => ({ binding: { ...binding }, authorizationDigest: AUTH });
  type Snapshot = ReturnType<typeof snapshot>;
  it("matches the exact verified binding snapshot", () => {
    expect(matchesNativeScheduleGrantSnapshot(grant(), snapshot() as never)).toBe(true);
  });
  it.each<[string, (s: Snapshot) => void]>([
    ["board id", (s) => { s.binding.boardId = "PVT_other"; }],
    ["board url", (s) => { s.binding.boardUrl = "https://github.com/orgs/example/projects/2"; }],
    ["connection", (s) => { s.binding.connectionId = JOB; }],
    ["account id", (s) => { s.binding.accountId = 1002; }],
    ["login", (s) => { s.binding.login = "other"; }],
    ["authorization digest", (s) => { s.authorizationDigest = "b".repeat(64); }],
  ])("refuses a changed %s", (_label, change) => {
    const current = snapshot();
    change(current);
    expect(matchesNativeScheduleGrantSnapshot(grant(), current as never)).toBe(false);
  });

  describe("retained grant read", () => {
    const db = {} as Db;
    const identity = { pluginId: PLUGIN, pluginKey: "paperclip-github-plugin" };
    const put = (value: unknown) => stored.set([PLUGIN, "company", COMPANY, GITHUB_PROJECT_BINDING_NAMESPACE,
      `schedule-grant:${PROJECT}`].join("|"), value);
    beforeEach(() => stored.clear());

    it("returns null when nothing is retained and the grant when scope matches", async () => {
      await expect(readRetainedNativeScheduleGrant(db, identity, { companyId: COMPANY, projectId: PROJECT })).resolves.toBeNull();
      put(grant());
      await expect(readRetainedNativeScheduleGrant(db, identity, { companyId: COMPANY, projectId: PROJECT }))
        .resolves.toEqual(grant());
    });
    it.each([
      ["company", { companyId: OTHER }],
      ["project", { projectId: OTHER }],
      ["plugin", { pluginId: OTHER }],
    ])("refuses a retained grant for another %s", async (_label, overrides) => {
      put(grant(overrides));
      await expect(readRetainedNativeScheduleGrant(db, identity, { companyId: COMPANY, projectId: PROJECT }))
        .rejects.toThrow(/scope differs/);
    });
    it("refuses a malformed scope request", async () => {
      await expect(readRetainedNativeScheduleGrant(db, identity, { companyId: "x", projectId: PROJECT })).rejects.toThrow();
    });
  });
});

describe("schedule grant target selection", () => {
  const revoked = grant({ enabled: false, revokedAt: iso(NOW + 1000), revokedByUserId: "user-2" });
  it("selects an enabled, unexpired, unrevoked grant of this job", () => {
    expect(select([row(grant())])).toEqual([{ companyId: COMPANY, projectId: PROJECT, jobId: JOB }]);
  });
  it("does not select a revoked grant", () => expect(select([row(revoked)])).toEqual([]));
  it("does not select a disabled grant", () => expect(select([row(grant({ enabled: false }))])).toEqual([]));
  it("does not select a grant of another job", () => expect(select([row(grant({ jobId: OTHER }))])).toEqual([]));
  it("honours the company filter", () => {
    expect(select([row(grant())], OTHER)).toEqual([]);
    expect(select([row(grant())], COMPANY)).toHaveLength(1);
  });
  it.each([
    ["a row scope that differs from the grant company", row(grant(), { scopeId: OTHER })],
    ["a state key for another project", row(grant(), { stateKey: `schedule-grant:${OTHER}` })],
    ["a grant of another plugin", row(grant({ pluginId: OTHER }))],
    ["a malformed grant", row({ nonsense: true })],
    ["a revoked grant that is still enabled", row({ ...grant(), revokedAt: iso(NOW + 1000), revokedByUserId: "u" })],
  ])("fails closed for %s", (_label, bad) => {
    expect(() => select([bad])).toThrow(/scope is invalid/);
  });
});
