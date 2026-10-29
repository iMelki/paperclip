/** Source-only proposal. No real database, filesystem fixture, timer or worker. */
import { describe, expect, it, vi } from "vitest";
import { pluginJobs } from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";

const pluginId = "plugin-fixture-1";
const originalJob = {
  id: "job-fixture-1",
  pluginId,
  jobKey: "sync.github-issues",
  schedule: "* * * * *",
  status: "paused",
  nextRunAt: new Date("2026-01-01T00:00:00Z"),
};

function declaration(schedule = originalJob.schedule) {
  return { jobKey: originalJob.jobKey, displayName: "Synthetic sync", schedule };
}

function makeJobFixture(jobs: Record<string, unknown>[] = [{ ...originalJob }], pluginExists = true) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async () => table === pluginJobs ? jobs : pluginExists ? [{ id: pluginId }] : [],
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    })),
    insert: vi.fn(() => ({ values: async (values: Record<string, unknown>) => { inserts.push(values); } })),
    delete: vi.fn(() => { throw new Error("Unexpected history deletion"); }),
  };
  return { db, updates, inserts, store: pluginJobStore(db as never) };
}

describe("plugin declaration reload retains operator pause", () => {
  it.each(["* * * * *", "*/5 * * * *"])("keeps a paused row for schedule %s", async (schedule) => {
    const fixture = makeJobFixture();
    await fixture.store.syncJobDeclarations(pluginId, [declaration(schedule)]);
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]).not.toHaveProperty("status");
    expect(fixture.updates[0]).not.toHaveProperty("nextRunAt");
    expect(fixture.updates[0]).not.toHaveProperty("id");
    if (schedule === originalJob.schedule) expect(fixture.updates[0]).not.toHaveProperty("schedule");
    else expect(fixture.updates[0]).toHaveProperty("schedule", schedule);
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.db.delete).not.toHaveBeenCalled();
  });

  it("does not reactivate on a second startup/declaration replay", async () => {
    const fixture = makeJobFixture();
    const declarations = [declaration()];
    await fixture.store.syncJobDeclarations(pluginId, declarations);
    await fixture.store.syncJobDeclarations(pluginId, declarations);
    expect(fixture.updates).toHaveLength(2);
    for (const update of fixture.updates) expect(update).not.toHaveProperty("status");
    expect(fixture.inserts).toHaveLength(0);
  });

  it.each(["active", "failed"])("retains existing %s status on reload", async (status) => {
    const fixture = makeJobFixture([{ ...originalJob, status }]);
    await fixture.store.syncJobDeclarations(pluginId, [declaration("*/5 * * * *")]);
    expect(fixture.updates[0]).not.toHaveProperty("status");
  });

  it("preserves the existing contract that genuinely new jobs start active", async () => {
    const fixture = makeJobFixture([]);
    await fixture.store.syncJobDeclarations(pluginId, [declaration()]);
    expect(fixture.inserts).toEqual([{
      pluginId, jobKey: originalJob.jobKey, schedule: originalJob.schedule, status: "active",
    }]);
    expect(fixture.updates).toHaveLength(0);
  });

  it("pauses a removed active declaration without deleting its row or history", async () => {
    const fixture = makeJobFixture([{ ...originalJob, status: "active" }]);
    await fixture.store.syncJobDeclarations(pluginId, []);
    expect(fixture.updates).toEqual([{ status: "paused", updatedAt: expect.any(Date) }]);
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.db.delete).not.toHaveBeenCalled();
  });

  it("refuses a missing plugin before inserting or updating jobs", async () => {
    const fixture = makeJobFixture([], false);
    await expect(fixture.store.syncJobDeclarations(pluginId, [declaration()]))
      .rejects.toThrow("Plugin not found");
    expect(fixture.db.update).not.toHaveBeenCalled();
    expect(fixture.db.insert).not.toHaveBeenCalled();
    expect(fixture.db.delete).not.toHaveBeenCalled();
  });
});
