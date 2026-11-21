import { and, eq, gte, lt, sql } from "drizzle-orm";
import { agents, companies, costEvents, type Db } from "@paperclipai/db";
import { createCostEventSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetEnforcementScope, type BudgetServiceHooks } from "./budgets.js";

type CostInput = Omit<typeof costEvents.$inferInsert, "companyId">;
type CostRow = typeof costEvents.$inferSelect;

function normalizePayload(data: CostInput) {
  if (!(data.occurredAt instanceof Date) || !Number.isFinite(data.occurredAt.getTime())) {
    throw unprocessable("Invalid cost event timestamp");
  }
  const parsed = createCostEventSchema.safeParse({ ...data, occurredAt: data.occurredAt.toISOString() });
  if (!parsed.success) throw unprocessable("Invalid cost event", parsed.error.flatten());
  const value = parsed.data;
  return {
    ...value,
    sourceSystem: value.sourceSystem ?? null,
    sourceAccountId: value.sourceAccountId ?? null,
    sourceEventId: value.sourceEventId ?? null,
    issueId: value.issueId ?? null,
    projectId: value.projectId ?? null,
    goalId: value.goalId ?? null,
    heartbeatRunId: value.heartbeatRunId ?? null,
    billingCode: value.billingCode ?? null,
    occurredAt: new Date(value.occurredAt),
  };
}

function samePayload(existing: CostRow, incoming: ReturnType<typeof normalizePayload>) {
  return Object.entries(incoming).every(([key, value]) => {
    const previous = existing[key as keyof CostRow];
    return value instanceof Date
      ? previous instanceof Date && value.getTime() === previous.getTime()
      : previous === value;
  });
}

async function monthlySpend(db: Db, companyId: string, agentId?: string) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await db.select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
    .from(costEvents).where(and(
      eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end),
      agentId ? eq(costEvents.agentId, agentId) : undefined,
    ));
  return Number(row?.total ?? 0);
}

async function insertOrReplay(db: Db, companyId: string, data: CostInput) {
  const payload = normalizePayload(data);
  const [agent] = await db.select().from(agents).where(eq(agents.id, payload.agentId));
  if (!agent) throw notFound("Agent not found");
  if (agent.companyId !== companyId) throw unprocessable("Agent does not belong to company");
  const insert = db.insert(costEvents).values({ ...payload, companyId, id: data.id, createdAt: data.createdAt });
  const [event] = await (payload.sourceEventId ? insert.onConflictDoNothing({ target: [
    costEvents.companyId, costEvents.sourceSystem, costEvents.sourceAccountId, costEvents.sourceEventId,
  ] }) : insert).returning();
  if (event) return { event, created: true };
  const [existing] = await db.select().from(costEvents).where(and(
    eq(costEvents.companyId, companyId), eq(costEvents.sourceSystem, payload.sourceSystem!),
    eq(costEvents.sourceAccountId, payload.sourceAccountId!), eq(costEvents.sourceEventId, payload.sourceEventId!),
  ));
  if (!existing || !samePayload(existing, payload)) {
    throw conflict("Source event identity already exists with a different cost payload");
  }
  return { event: existing, created: false };
}

export function costEventIngestion(db: Db, hooks: BudgetServiceHooks = {}) {
  async function createEventWithOutcome(companyId: string, data: CostInput) {
    const cancellations: BudgetEnforcementScope[] = [];
    const result = await db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      // Serialize company totals, including different events arriving concurrently.
      const [company] = await tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, companyId)).for("update");
      if (!company) throw notFound("Company not found");
      const result = await insertOrReplay(store, companyId, data);
      const { event } = result;
      if (result.created) {
        const agentSpend = await monthlySpend(store, companyId, event.agentId);
        const companySpend = await monthlySpend(store, companyId);
        await tx.update(agents).set({ spentMonthlyCents: agentSpend, updatedAt: new Date() })
          .where(eq(agents.id, event.agentId));
        await tx.update(companies).set({ spentMonthlyCents: companySpend, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
      }
      // Replays retry hard-stop cancellation after a prior post-commit hook failure.
      // Budget incidents already deduplicate by policy/window/threshold.
      await budgetService(store, { cancelWorkForScope: async (scope) => { cancellations.push(scope); } })
        .evaluateCostEvent(event);
      return result;
    });
    // Database pauses commit before cancellation hooks inspect live work. Hooks
    // must tolerate repeated cancellation; a replay never adds cost or cost audit.
    for (const scope of cancellations) await hooks.cancelWorkForScope?.(scope);
    return result;
  }
  return {
    createEventWithOutcome,
    createEvent: async (companyId: string, data: CostInput) => (await createEventWithOutcome(companyId, data)).event,
  };
}
