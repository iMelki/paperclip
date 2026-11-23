import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  projects,
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
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(budgetPolicies);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createAgent(opts: { withBudget: boolean; scope?: "agent" | "company" }) {
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
        scopeType: opts.scope ?? "agent",
        scopeId: opts.scope === "company" ? companyId : agentId,
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
    sessionBefore?: string | null;
    cost?: boolean;
    reason?: string;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      finishedAt: input.finishedAt,
      sessionIdBefore: input.sessionBefore ?? null,
      sessionIdAfter: input.session ?? null,
      resultJson: {
        usage_status: input.usageStatus,
        ...(input.reason ? { usage_unavailable_reason: input.reason } : {}),
      },
    });
    if (input.cost) {
      await db.insert(costEvents).values({
        companyId: input.companyId,
        agentId: input.agentId,
        heartbeatRunId: id,
        provider: "test",
        model: "test-model",
        costCents: 5,
        occurredAt: input.finishedAt,
      });
    }
    return id;
  }

  async function addAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Second Agent",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
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

    // A report of the same session whose cost event is not recorded yet does not.
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T12:00:00Z"),
      session: "sess-1",
    });
    expect(await service.getInvocationBlock(companyId, agentId)).not.toBeNull();

    // Once the cost event is durably recorded for a same-session report, it does.
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T13:00:00Z"),
      session: "sess-1",
      cost: true,
    });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
  });

  it("stays blocked when the unknown run recorded no session, even after a measured run elsewhere", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: null,
    });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T11:00:00Z"),
      session: "sess-other",
      cost: true,
    });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).not.toBeNull();
  });

  it("a report from a rotated session (before = old session, after = new) does not clear the old hold", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T11:00:00Z"),
      sessionBefore: "sess-1",
      session: "sess-2",
      cost: true,
    });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).not.toBeNull();
  });

  it("recovers only the matching unknown run when several are open", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T09:00:00Z"),
      session: "sess-1",
    });
    const second = await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-2",
    });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T11:00:00Z"),
      session: "sess-1",
      cost: true,
    });
    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block?.reason).toContain(second);
  });

  it("another agent's recovery never clears this agent's hold", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true });
    const otherAgentId = await addAgent(companyId);
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    await insertRun({
      companyId,
      agentId: otherAgentId,
      usageStatus: "reported",
      finishedAt: new Date("2026-11-01T11:00:00Z"),
      session: "sess-1",
      cost: true,
    });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).not.toBeNull();
  });

  it("blocks an unmeasured run under a company-scope hard stop with no agent policy", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: true, scope: "company" });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "agent",
      scopeId: agentId,
    });
  });

  it("blocks an unmeasured run under a project-scope hard stop with no agent or company policy (#301)", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: false });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Budgeted project" });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    const runId = await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    const block = await budgetService(db).getInvocationBlock(companyId, agentId, { projectId });
    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
    expect(block?.reason).toContain(runId);
    // A wake for an unrelated project (or none) with no hard stop in scope is not blocked.
    expect(await budgetService(db).getInvocationBlock(companyId, agentId)).toBeNull();
  });

  it("does not block under a project-scope policy without a hard stop", async () => {
    const { companyId, agentId } = await createAgent({ withBudget: false });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Soft project" });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });
    await insertRun({
      companyId,
      agentId,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
    });
    expect(await budgetService(db).getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
  });
});
