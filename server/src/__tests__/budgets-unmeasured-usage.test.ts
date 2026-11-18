import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService unmeasured usage block (#294)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-unmeasured-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createAgent(opts: { withBudget: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes Agent",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (opts.withBudget) {
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 1000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      });
    }
    return { companyId, agentId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    usageStatus: "unknown" | "reported";
    finishedAt: Date;
    session?: string | null;
    reason?: string;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      finishedAt: input.finishedAt,
      sessionIdAfter: input.session ?? null,
      resultJson: {
        usage_status: input.usageStatus,
        ...(input.reason ? { usage_unavailable_reason: input.reason } : {}),
      },
    });
    return id;
  }

  it("blocks the next wake after an unknown-usage run and names the run", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    const runId = await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
      reason: "session export timed out",
    });

    const block = await budgetService(db).getInvocationBlock(companyId, agentId);

    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
    expect(block?.reason).toContain(runId);
    expect(block?.reason).toContain("unmeasured usage");
    expect(block?.reason).toContain("session export timed out");
  });

  it("does not block on a reported run, or when the agent has no budget", async () => {
    const reported = await createAgent({ withBudget: true });
    await insertRun({
      ...reported,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    expect(await budgetService(db).getInvocationBlock(reported.companyId, reported.agentId)).toBeNull();

    const noBudget = await createAgent({ withBudget: false });
    await insertRun({
      ...noBudget,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    expect(await budgetService(db).getInvocationBlock(noBudget.companyId, noBudget.agentId)).toBeNull();
  });

  it("clears the block once a later reported run of the same session recovers it", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    const service = budgetService(db);
    expect(await service.getInvocationBlock(companyId, agentId)).not.toBeNull();

    // A measured run of a different session does not recover the lost share.
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T11:00:00Z"),
      session: "sess-other",
    });
    expect(await service.getInvocationBlock(companyId, agentId)).not.toBeNull();

    // A measured run of the same session does.
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T12:00:00Z"),
      session: "sess-1",
    });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
  });
});
