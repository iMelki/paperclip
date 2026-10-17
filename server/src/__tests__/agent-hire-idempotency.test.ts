import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentHireRequests, agents, approvals, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { createAgentHireSchema } from "@paperclipai/shared";
import { agentRoutes } from "../routes/agents.js";
import { executeAgentHire, fingerprintHireRequest } from "../services/agent-hire-idempotency.js";
import { agentService } from "../services/agents.js";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Hire idempotency Postgres tests skipped: ${support.reason}`);

describePostgres("agent hire idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hire-idempotency-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    // Hold the first agent insert open long enough for the competing HTTP
    // request to reach the unique-index claim, on a separate real connection.
    await db.execute(sql`create function hire_test_delay() returns trigger as $$
      begin perform pg_sleep(0.3); return new; end;
    $$ language plpgsql`);
    await db.execute(sql`create trigger hire_test_delay before insert on agents
      for each row when (new.metadata->>'concurrencyBarrier' = 'true')
      execute function hire_test_delay()`);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(requiresApproval = true) {
    const [company] = await db.insert(companies).values({
      name: "Hire test company",
      issuePrefix: `H${randomUUID().slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: requiresApproval,
    }).returning();
    const app = express();
    let actor: Express.Request["actor"] = {
      type: "board", source: "local_implicit", userId: "test-board", isInstanceAdmin: true,
    };
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const payload = { name: "Founding Product Engineer", role: "engineer", adapterType: "process" };
    const url = `/api/companies/${company.id}/agent-hires`;
    const hire = (key?: string, body: object = payload) => {
      const pending = request(app).post(url);
      if (key !== undefined) pending.set("Idempotency-Key", key);
      return pending.send(body);
    };
    return { company, app, payload, url, hire, setActor: (value: Express.Request["actor"]) => { actor = value; } };
  }

  async function counts(companyId: string) {
    return {
      agents: (await db.select().from(agents).where(eq(agents.companyId, companyId))).length,
      approvals: (await db.select().from(approvals).where(eq(approvals.companyId, companyId))).length,
      activities: (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).length,
      runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length,
    };
  }

  it("two concurrent identical requests create exactly one agent and approval", async () => {
    const f = await fixture();
    const payload = { ...f.payload, metadata: { concurrencyBarrier: true } };
    const [first, second] = await Promise.all([
      f.hire("hire:plan:revision:1", payload), f.hire("hire:plan:revision:1", payload),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(second.body.agent.id).toBe(first.body.agent.id);
    expect(second.body.approval.id).toBe(first.body.approval.id);
    expect(await counts(f.company.id)).toEqual({ agents: 1, approvals: 1, activities: 2, runs: 0 });
    const receipts = await db.select().from(agentHireRequests).where(eq(agentHireRequests.companyId, f.company.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].agentId).toBe(first.body.agent.id);
    expect(receipts[0].approvalId).toBe(first.body.approval.id);
    expect(receipts[0].requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a repeated request returns the same hire without new side effects", async () => {
    const f = await fixture(false);
    const first = await f.hire("hire:plan:revision:1");
    expect(first.status).toBe(201);
    const before = await counts(f.company.id);
    const second = await f.hire("hire:plan:revision:1");
    expect(second.status).toBe(200);
    expect(second.body.agent.id).toBe(first.body.agent.id);
    expect(second.body.approval).toBeNull();
    expect(await counts(f.company.id)).toEqual(before);
  });

  it("rejects a different payload with the same key with 409", async () => {
    const f = await fixture();
    const first = await f.hire("hire:plan:revision:1");
    expect(first.status).toBe(201);
    const second = await f.hire("hire:plan:revision:1", { ...f.payload, title: "Different role" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("different hire payload");
    expect(await counts(f.company.id)).toEqual({ agents: 1, approvals: 1, activities: 2, runs: 0 });
  });

  it("keeps requests without a key distinct", async () => {
    const f = await fixture(false);
    const first = await f.hire();
    const second = await f.hire();
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.agent.id).not.toBe(first.body.agent.id);
    expect(second.body.agent.name).toBe("Founding Product Engineer 2");
    expect(await counts(f.company.id)).toEqual({ agents: 2, approvals: 0, activities: 2, runs: 0 });
  });

  it("accepts the body alternative and replays it through the header", async () => {
    const f = await fixture();
    const first = await f.hire(undefined, { ...f.payload, idempotencyKey: "hire:plan:revision:1" });
    expect(first.status).toBe(201);
    const second = await f.hire("hire:plan:revision:1");
    expect(second.status).toBe(200);
    expect(second.body.agent.id).toBe(first.body.agent.id);
  });

  it("rejects mismatched header/body keys and empty or oversized keys", async () => {
    const f = await fixture(false);
    const mismatch = await f.hire("one", { ...f.payload, idempotencyKey: "two" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toContain("must match");
    for (const key of ["", "x".repeat(256)]) {
      const response = await f.hire(key);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("1 to 255");
    }
    expect((await counts(f.company.id)).agents).toBe(0);
  });

  it("normalizes schema defaults and nested object order before fingerprinting", async () => {
    const f = await fixture(false);
    const first = await f.hire("canonical", { ...f.payload, metadata: { a: 1, nested: { b: true, c: "value" } } });
    expect(first.status).toBe(201);
    const second = await f.hire("canonical", {
      adapterType: "process", role: "engineer", name: f.payload.name,
      metadata: { nested: { c: "value", b: true }, a: 1 },
      adapterConfig: {}, runtimeConfig: {}, budgetMonthlyCents: 0,
    });
    expect(second.status).toBe(200);
    expect(second.body.agent.id).toBe(first.body.agent.id);
    const changed = await f.hire("canonical", { ...f.payload, metadata: { a: "1", nested: { b: true, c: "value" } } });
    expect(changed.status).toBe(409);
  });

  it("scopes keys by company and keeps different hire slots distinct", async () => {
    const firstCompany = await fixture(false);
    const otherCompany = await fixture(false);
    const first = await firstCompany.hire("hire:plan:revision:1");
    const second = await firstCompany.hire("hire:plan:revision:2");
    const other = await otherCompany.hire("hire:plan:revision:1");
    expect([first.status, second.status, other.status]).toEqual([201, 201, 201]);
    expect(new Set([first.body.agent.id, second.body.agent.id, other.body.agent.id]).size).toBe(3);
  });

  it("checks company access on a replay before returning the original hire", async () => {
    const f = await fixture(false);
    expect((await f.hire("private-hire")).status).toBe(201);
    f.setActor({ type: "agent", source: "agent_key", agentId: randomUUID(), companyId: randomUUID() });
    const denied = await f.hire("private-hire");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("another company");
  });

  it("rolls back the claim and agent when approval issue linking fails", async () => {
    const f = await fixture();
    const failed = await f.hire("recoverable", { ...f.payload, sourceIssueId: randomUUID() });
    expect(failed.status).toBe(404);
    expect(failed.body.error).toBe("One or more issues not found");
    expect(await counts(f.company.id)).toEqual({ agents: 0, approvals: 0, activities: 0, runs: 0 });
    const recovered = await f.hire("recoverable");
    expect(recovered.status).toBe(201);
    expect(await counts(f.company.id)).toEqual({ agents: 1, approvals: 1, activities: 2, runs: 0 });
  });

  it("returns current governance state without reactivating a terminated hire", async () => {
    const f = await fixture(false);
    const first = await f.hire("terminated");
    expect(first.status).toBe(201);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, first.body.agent.id));
    const replay = await f.hire("terminated");
    expect(replay.status).toBe(200);
    expect(replay.body.agent.id).toBe(first.body.agent.id);
    expect(replay.body.agent.status).toBe("terminated");
    expect((await counts(f.company.id)).agents).toBe(1);
  });

  it("does not disclose later configuration to a hiring actor without config-read permission", async () => {
    const f = await fixture(false);
    const first = await f.hire("private-config");
    expect(first.status).toBe(201);
    const [manager] = await db.insert(agents).values({
      companyId: f.company.id, name: "Hiring manager", role: "engineer",
      permissions: { canCreateAgents: true }, adapterType: "process", status: "idle",
    }).returning();
    await db.update(agents).set({
      adapterConfig: { privateMarker: "later operator configuration" },
      runtimeConfig: { privateMarker: "later runtime configuration" },
    }).where(eq(agents.id, first.body.agent.id));
    f.setActor({ type: "agent", source: "agent_key", agentId: manager.id, companyId: f.company.id });
    const replay = await f.hire("private-config");
    expect(replay.status).toBe(200);
    expect(replay.body.agent.id).toBe(first.body.agent.id);
    expect(replay.body.agent.adapterConfig).toEqual({});
    expect(replay.body.agent.runtimeConfig).toEqual({});
  });

  it("redacts stored approval payload secrets on replay", async () => {
    const f = await fixture();
    const first = await f.hire("redacted-approval");
    expect(first.status).toBe(201);
    await db.update(approvals).set({
      payload: { ...first.body.approval.payload, authorization: "test-only-value" },
    }).where(eq(approvals.id, first.body.approval.id));
    const replay = await f.hire("redacted-approval");
    expect(replay.status).toBe(200);
    expect(replay.body.approval.id).toBe(first.body.approval.id);
    expect(replay.body.approval.payload.authorization).toBe("***REDACTED***");
    expect(await counts(f.company.id)).toEqual({ agents: 1, approvals: 1, activities: 2, runs: 0 });
  });

  it("prepares outside the hire transaction with a one-connection pool and skips preparation on replay", async () => {
    const f = await fixture(false);
    const single = createDb(tempDb.connectionString, { maxConnections: 1 });
    const prepare = async () => single.select().from(companies).where(eq(companies.id, f.company.id));
    const create = async (source: typeof db) => ({
      agent: await agentService(source).create(f.company.id, { name: "Prepared engineer", adapterType: "process" }),
      approval: null,
    });
    const first = await executeAgentHire(single, f.company.id, "prepared", "fingerprint", prepare, create);
    expect(first.replayed).toBe(false);
    const replay = await executeAgentHire(single, f.company.id, "prepared", "fingerprint", async () => {
      throw new Error("Replay must skip preparation");
    }, create);
    expect(replay.replayed).toBe(true);
    expect(replay.result.agent.id).toBe(first.result.agent.id);
  });

  it("reserves an unavailable original hire identity instead of creating a replacement", async () => {
    const f = await fixture(false);
    await db.insert(agentHireRequests).values({
      companyId: f.company.id, idempotencyKey: "unavailable",
      requestFingerprint: fingerprintHireRequest(createAgentHireSchema.parse(f.payload), []),
      agentId: randomUUID(),
    });
    const replay = await f.hire("unavailable");
    expect(replay.status).toBe(409);
    expect(replay.body.error).toContain("original idempotent hire is unavailable");
    expect((await counts(f.company.id)).agents).toBe(0);
  });
});
