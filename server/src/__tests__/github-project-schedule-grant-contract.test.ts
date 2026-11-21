import { describe, expect, it } from "vitest";
import { createScheduleGrantSchema, scheduleGrantDeadline, scheduleGrantSchema } from "../services/github-project-schedule-grant-contract.js";

const id = "00000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const base = {
  companyId: id, projectId: id, pluginId: id, grantId: id, revision: 1,
  jobId: id, jobKey: "sync.github-project-board", enabled: true, maxItems: 20,
  boardId: "board", boardUrl: "https://github.com/users/example/projects/12",
  connectionId: id, accountId: 1, login: "example", bindingDigest: digest, authorizationDigest: digest,
  grantedByUserId: "user", grantedAt: "2026-11-10T00:00:00.000Z",
  revokedAt: null, revokedByUserId: null, importOnly: true, noDispatch: true,
};

describe("GitHub board schedule grants", () => {
  it("retains the original 24-hour limit for existing version 1 grants", () => {
    expect(scheduleGrantSchema.safeParse({ ...base, version: 1, expiresAt: "2026-11-11T00:00:00.000Z" }).success).toBe(true);
    expect(scheduleGrantSchema.safeParse({ ...base, version: 1, expiresAt: "2026-11-11T00:00:00.001Z" }).success).toBe(false);
    expect(scheduleGrantSchema.safeParse({ ...base, version: 1, expiresAt: null }).success).toBe(false);
  });

  it("requires explicit durable authorization and keeps it revocable", () => {
    const durable = scheduleGrantSchema.parse({ ...base, version: 2, expiresAt: null });
    expect(scheduleGrantDeadline(durable)).toBe(Number.POSITIVE_INFINITY);
    expect(createScheduleGrantSchema.safeParse({ companyId: id, projectId: id, jobId: id, expectedRevision: 0, maxItems: 20 }).success).toBe(false);
    expect(scheduleGrantSchema.safeParse({ ...durable, expiresAt: "2026-11-11T00:00:00.000Z" }).success).toBe(false);
    expect(scheduleGrantSchema.safeParse({ ...durable, enabled: false, revokedAt: "2026-11-10T01:00:00.000Z", revokedByUserId: "user" }).success).toBe(true);
    expect(scheduleGrantSchema.safeParse({ ...durable, revokedAt: "2026-11-10T01:00:00.000Z", revokedByUserId: "user" }).success).toBe(false);
  });

  it("rejects durable grants that could dispatch agents or write to GitHub", () => {
    expect(scheduleGrantSchema.safeParse({ ...base, version: 2, expiresAt: null, noDispatch: false }).success).toBe(false);
    expect(scheduleGrantSchema.safeParse({ ...base, version: 2, expiresAt: null, importOnly: false }).success).toBe(false);
  });
});
