import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { pluginJobStore } from "../services/plugin-job-store.js";

function fixture() {
  const inserts: Record<string, unknown>[] = [];
  const predicates: { sql: string; params: unknown[] }[] = [];
  const db = {
    insert: vi.fn(() => ({ values: (value: Record<string, unknown>) => {
      inserts.push(value); return { returning: async () => [{ id: "synthetic-run", ...value }] };
    } })),
    update: vi.fn(() => ({ set: () => ({ where: async (where: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      predicates.push(new PgDialect().sqlToQuery(where));
    } }) })),
  };
  return { store: pluginJobStore(db as never), inserts, predicates };
}
describe("company job execution persistence", () => {
  it("writes the host-selected company to the already-existing column", async () => {
    const f = fixture();
    await f.store.createRun({ jobId: "synthetic-job", pluginId: "synthetic-plugin",
      trigger: "schedule", companyId: "company-a" });
    expect(f.inserts).toEqual([{ jobId: "synthetic-job", pluginId: "synthetic-plugin",
      companyId: "company-a", trigger: "schedule", status: "queued" }]);
  });
  it("keeps legacy instance records null-scoped", async () => {
    const f = fixture();
    await f.store.createRun({ jobId: "synthetic-job", pluginId: "synthetic-plugin", trigger: "manual" });
    expect(f.inserts[0]).toHaveProperty("companyId", null);
  });
  it("cannot move a cancelled/terminal row back to running", async () => {
    const f = fixture(); await f.store.markRunning("synthetic-run");
    expect(f.predicates[0]?.sql).toContain('"status" =');
    expect(f.predicates[0]?.params).toEqual(["synthetic-run", "queued"]);
  });
  it("only completes pending/queued/running rows, preserving cancellation and terminal history", async () => {
    const f = fixture(); await f.store.completeRun("synthetic-run", { status: "succeeded" });
    expect(f.predicates[0]?.sql).toContain('"status" in');
    expect(f.predicates[0]?.params).toEqual(["synthetic-run", "pending", "queued", "running"]);
  });
});
