import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, type Db } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS, getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("immutable cost source events", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-cost-source-events-");
    db = createDb(fixture.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    try { await db?.$client.end({ timeout: 5 }); }
    finally { await fixture?.cleanup(); }
  });

  async function scope() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cost import fixture", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Import agent", role: "engineer", adapterType: "process" });
    const data = { agentId, sourceSystem: "provider-export", sourceAccountId: "account-a", sourceEventId: "event-1",
      provider: "openai", model: "test-model", costCents: 25, inputTokens: 100, occurredAt: new Date() };
    return { companyId, agentId, data, service: costService(db) };
  }

  it("returns the original event for concurrent identical replays without double-counting", async () => {
    const { companyId, agentId, data, service } = await scope();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => service.createEventWithOutcome(companyId, data)));
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.event.id)).size).toBe(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(agent.spentMonthlyCents).toBe(25);
    expect(company.spentMonthlyCents).toBe(25);
    const normalized = await service.createEvent(companyId, { ...data, biller: "openai", outputTokens: 0, issueId: null });
    expect(normalized.id).toBe(outcomes[0].event.id);
  });

  it("rejects changed financial or attribution payloads with 409 and preserves the original", async () => {
    const { companyId, data, service } = await scope();
    const original = await service.createEvent(companyId, data);
    for (const change of [{ costCents: 26 }, { inputTokens: 101 }, { model: "changed" },
      { billingCode: "different-task" }, { occurredAt: new Date(data.occurredAt.getTime() + 1) }]) {
      expect({ ...data, ...change }).not.toEqual(data);
      await expect(service.createEvent(companyId, { ...data, ...change })).rejects.toMatchObject({
        status: 409, message: "Source event identity already exists with a different cost payload",
      });
    }
    expect(await service.createEvent(companyId, data)).toEqual(original);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
  });

  it("scopes source identity to company, source system and account and preserves legacy inserts", async () => {
    const first = await scope();
    const second = await scope();
    await first.service.createEvent(first.companyId, first.data);
    await second.service.createEvent(second.companyId, second.data);
    await first.service.createEvent(first.companyId, { ...first.data, sourceAccountId: "account-b" });
    await first.service.createEvent(first.companyId, { ...first.data, sourceSystem: "another-export" });
    const legacy = { ...first.data, sourceSystem: null, sourceAccountId: null, sourceEventId: null };
    expect((await first.service.createEvent(first.companyId, legacy)).id)
      .not.toBe((await first.service.createEvent(first.companyId, legacy)).id);
    await expect(first.service.createEvent(second.companyId, first.data)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, first.companyId))).toHaveLength(5);
  });

  it("rejects partial identities in the database and accepts the complete repair", async () => {
    const { companyId, data } = await scope();
    const broken = { ...data, companyId, sourceAccountId: null };
    expect(broken.sourceAccountId).toBeNull();
    await expect(db.insert(costEvents).values(broken)).rejects.toMatchObject({ cause: expect.objectContaining({
      code: "23514", constraint_name: "cost_events_source_identity_complete_ck",
    }) });
    await db.insert(costEvents).values({ ...broken, sourceAccountId: "repaired" });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
  });

  it("commits budget pauses and retries failed cancellation on replay without adding cost", async () => {
    const { companyId, data } = await scope();
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 20 });
    const cancel = vi.fn(async () => {
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(company.pauseReason).toBe("budget");
    });
    cancel.mockRejectedValueOnce(new Error("Cancellation unavailable"));
    const service = costService(db, { cancelWorkForScope: cancel });
    await expect(service.createEvent(companyId, data)).rejects.toThrow("Cancellation unavailable");
    await service.createEvent(companyId, data);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
    const [event] = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.sourceEventId, "event-1")));
    expect(event.costCents).toBe(25);
  });
});
