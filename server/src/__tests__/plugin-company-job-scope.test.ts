import { describe, expect, it, vi } from "vitest";
import { createPluginJobEnvelope, resolvePluginJobDispatchPlan, selectPluginJobCompanies }
  from "../services/plugin-job-scope.js";

describe("host-owned plugin company job planning", () => {
  it.each([undefined, "instance"])("preserves legacy %s without reading company configuration", async (dispatchScope) => {
    const read = vi.fn(async () => ["company-a"]);
    expect(await resolvePluginJobDispatchPlan({ dispatchScope }, read)).toEqual({ scope: "instance", companyIds: [] });
    expect(read).not.toHaveBeenCalled();
  });
  it("normalizes only duplicate/order, never guesses a tenant", async () => {
    expect(await resolvePluginJobDispatchPlan({ dispatchScope: "company" }, async () => ["company-b", "company-a", "company-b"]))
      .toEqual({ scope: "company", companyIds: ["company-a", "company-b"] });
  });
  it.each([[], [""], [" company-a"], [null]])("fails closed for invalid host company rows %j", async (ids) => {
    await expect(resolvePluginJobDispatchPlan({ dispatchScope: "company" }, async () => ids)).rejects.toThrow();
  });
  it.each([{}, null, "all"])("rejects unknown scope %j", async (dispatchScope) => {
    await expect(resolvePluginJobDispatchPlan({ dispatchScope }, async () => [])).rejects.toThrow("Unsupported");
  });
  it("does not convert a missing declaration or lookup failure into an instance job", async () => {
    await expect(resolvePluginJobDispatchPlan(undefined, async () => [])).rejects.toThrow("no longer declared");
    await expect(resolvePluginJobDispatchPlan({ dispatchScope: "company" }, async () => { throw new Error("database down"); }))
      .rejects.toThrow("database down");
  });
  it("sends matching tenant identity in the envelope and handler context", () => {
    expect(createPluginJobEnvelope("sync", "run-a", "schedule", "2026-10-23T00:00:00Z", "company-a"))
      .toEqual({ companyId: "company-a", job: { companyId: "company-a", jobKey: "sync", runId: "run-a",
        trigger: "schedule", scheduledAt: "2026-10-23T00:00:00Z" } });
    expect(createPluginJobEnvelope("sync", "run-1", "manual", "now", null)).not.toHaveProperty("companyId");
    expect(createPluginJobEnvelope("sync", "run-1", "manual", "now", null).job).not.toHaveProperty("companyId");
  });
  it("company retries never fan out or switch to another configured company", () => {
    const plan = { scope: "company" as const, companyIds: ["company-a", "company-b"] };
    expect(selectPluginJobCompanies(plan, "retry", "company-b")).toEqual(["company-b"]);
    expect(() => selectPluginJobCompanies(plan, "retry")).toThrow("original company ID");
    expect(() => selectPluginJobCompanies(plan, "retry", "company-c")).toThrow("not configured");
    expect(selectPluginJobCompanies({ scope: "instance", companyIds: [] }, "retry")).toEqual([null]);
  });
});
