import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", () => ({ plugins: {}, pluginJobs: {}, pluginState: {} }));
vi.mock("../services/plugin-github-project-board.js", () => ({
  GITHUB_PROJECT_BINDING_NAMESPACE: "fixture", GITHUB_PROJECT_IMPORTER_KEY: "fixture",
}));

import { selectNativeBoardJobTargets } from "../services/github-project-board-job-targets.js";
import { selectNativeBoardJobTargets as legacyTargets } from "./helpers/github-project-board-job-targets-v1.fixture.js";
import { legacyScheduleGrantMarker, scheduleGrantSchema } from "../services/github-project-schedule-grant-contract.js";

const pluginId = "00000000-0000-4000-8000-000000000001";
const companyId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const grant = {
  version: 2, pluginId, companyId, projectId, jobId, grantId: pluginId, revision: 1,
  jobKey: "sync.github-project-board", enabled: true, maxItems: 20,
  boardId: "board", boardUrl: "https://github.com/users/example/projects/12", connectionId: jobId,
  accountId: 1, login: "example", bindingDigest: "a".repeat(64), authorizationDigest: "b".repeat(64),
  grantedByUserId: "user", grantedAt: "2026-11-10T00:00:00.000Z", expiresAt: null,
  revokedAt: null, revokedByUserId: null, importOnly: true, noDispatch: true,
};
const row = (valueJson: unknown, scopeId = companyId) => ({ scopeId, stateKey: `schedule-grant:${projectId}`, valueJson });
const durableRow = (valueJson: unknown) => ({ scopeId: companyId, stateKey: `durable-schedule-grant:${projectId}`, valueJson });
const marker = () => legacyScheduleGrantMarker(scheduleGrantSchema.parse(grant));

describe("native scheduler durable target selection", () => {
  it("selects the explicitly durable board while continuing to reject expired legacy grants", () => {
    const legacy = { ...grant, version: 1, expiresAt: "2026-11-10T12:00:00.000Z" };
    const now = Date.parse("2026-12-01T00:00:00.000Z");
    expect(selectNativeBoardJobTargets([row(marker()), durableRow(grant)], pluginId, jobId, companyId, now)).toEqual([{ companyId, projectId, jobId }]);
    expect(legacyTargets([row(marker())], pluginId, jobId, companyId, now)).toEqual([]);
    expect(selectNativeBoardJobTargets([row(legacy)], pluginId, jobId, companyId, now)).toEqual([]);
  });
  it("refuses revoked or disabled durable grants and tampered scopes", () => {
    const revoked = { ...grant, version: 1, expiresAt: "2026-11-11T00:00:00.000Z", enabled: false,
      revokedAt: "2026-11-10T01:00:00.000Z", revokedByUserId: "user" };
    expect(selectNativeBoardJobTargets([row(revoked), durableRow(revoked)], pluginId, jobId)).toEqual([]);
    const disabled = { ...grant, enabled: false };
    expect(selectNativeBoardJobTargets([row(legacyScheduleGrantMarker(scheduleGrantSchema.parse(disabled))), durableRow(disabled)], pluginId, jobId)).toEqual([]);
    expect(() => selectNativeBoardJobTargets([row(marker(), jobId), durableRow(grant)], pluginId, jobId)).toThrow();
    expect(() => selectNativeBoardJobTargets([row(marker()), durableRow({ ...grant, noDispatch: false })], pluginId, jobId)).toThrow();
    expect(() => selectNativeBoardJobTargets([row({ ...marker(), revision: 2 }), durableRow(grant)], pluginId, jobId)).toThrow();
    expect(() => selectNativeBoardJobTargets([durableRow(grant)], pluginId, jobId)).toThrow();
  });
});
