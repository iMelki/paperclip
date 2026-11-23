import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { budgetService, ledgerProjectIdOfRunSql } from "../services/budgets.ts";
import { resolveLedgerScopeForRun } from "../services/heartbeat.ts";
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
    await db.delete(issues);
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
    costProjectId?: string | null;
    // Attribute the cost event the way the ledger does (resolveLedgerScopeForRun), not by hand.
    ledgerAttributed?: boolean;
    contextSnapshot?: Record<string, unknown>;
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
      contextSnapshot: input.contextSnapshot ?? null,
      resultJson: {
        usage_status: input.usageStatus,
        ...(input.reason ? { usage_unavailable_reason: input.reason } : {}),
      },
    });
    if (input.cost) {
      let projectId = input.costProjectId ?? null;
      let issueId: string | null = null;
      if (input.ledgerAttributed) {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
        const scope = await resolveLedgerScopeForRun(db, input.companyId, row);
        projectId = scope.projectId;
        issueId = scope.issueId;
      }
      await db.insert(costEvents).values({
        companyId: input.companyId,
        agentId: input.agentId,
        heartbeatRunId: id,
        provider: "test",
        model: "test-model",
        costCents: 5,
        projectId,
        issueId,
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

  async function setupProjects() {
    const { companyId, agentId } = await createAgent({ withBudget: false });
    const projectA = randomUUID();
    const projectB = randomUUID();
    await db.insert(projects).values([
      { id: projectA, companyId, name: "Budgeted project A" },
      { id: projectB, companyId, name: "Other project B" },
    ]);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectA,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    const issueIn = async (projectId: string) => {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId, projectId, title: "Issue", status: "todo" });
      return id;
    };
    return { companyId, agentId, projectA, projectB, issueA: await issueIn(projectA), issueB: await issueIn(projectB) };
  }

  const unknownRun = (
    t: { companyId: string; agentId: string },
    contextSnapshot: Record<string, unknown> | undefined,
  ) =>
    insertRun({
      ...t,
      usageStatus: "unknown",
      finishedAt: new Date("2026-11-01T10:00:00Z"),
      session: "sess-1",
      contextSnapshot,
    });

  it("blocks after an unknown run in project A, names the project, and recovers only via a cost event charged to A", async () => {
    const t = await setupProjects();
    const runId = await unknownRun(t, { issueId: t.issueA });
    const service = budgetService(db);
    const block = await service.getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA });
    expect(block).toMatchObject({ scopeType: "agent", scopeId: t.agentId });
    expect(block?.reason).toContain(runId);
    expect(block?.reason).toContain("Budgeted project A");
    expect(block?.reason).toContain("charged to that project");

    // A later same-session run charged to project B does not clear A's hold.
    await insertRun({
      companyId: t.companyId, agentId: t.agentId, usageStatus: "reported", session: "sess-1",
      finishedAt: new Date("2026-11-01T11:00:00Z"), cost: true, ledgerAttributed: true,
      contextSnapshot: { issueId: t.issueB },
    });
    expect(await service.getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).not.toBeNull();

    // A later same-session run whose issue is in A (attributed by the ledger rule) clears it.
    await insertRun({
      companyId: t.companyId, agentId: t.agentId, usageStatus: "reported", session: "sess-1",
      finishedAt: new Date("2026-11-01T12:00:00Z"), cost: true, ledgerAttributed: true,
      contextSnapshot: { issueId: t.issueA },
    });
    expect(await service.getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).toBeNull();
  });

  it("an unknown run in project B does not block a wake into hard-stopped project A", async () => {
    const t = await setupProjects();
    await unknownRun(t, { issueId: t.issueB });
    expect(await budgetService(db).getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).toBeNull();
  });

  it("an unknown run with no project does not block a wake into project A", async () => {
    const t = await setupProjects();
    await unknownRun(t, undefined);
    expect(await budgetService(db).getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).toBeNull();
  });

  it("attributes an unknown run by the context projectId when it has no issue", async () => {
    const t = await setupProjects();
    await unknownRun(t, { projectId: t.projectA });
    expect(await budgetService(db).getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).not.toBeNull();
  });

  it("does not block under a project-scope policy without a hard stop", async () => {
    const t = await setupProjects();
    await db.update(budgetPolicies).set({ hardStopEnabled: false });
    await unknownRun(t, { issueId: t.issueA });
    expect(await budgetService(db).getInvocationBlock(t.companyId, t.agentId, { projectId: t.projectA })).toBeNull();
  });

  it("SQL run-to-project attribution matches resolveLedgerScopeForRun (drift guard)", async () => {
    const t = await setupProjects();
    const cases: Array<Record<string, unknown> | undefined> = [
      { issueId: t.issueA },
      { issueId: t.issueB, projectId: t.projectA },
      { projectId: t.projectB },
      { issueId: randomUUID(), projectId: t.projectA },
      { issueId: randomUUID(), projectId: "" },
      { issueId: "", projectId: t.projectA },
      undefined,
    ];
    for (const contextSnapshot of cases) {
      const id = await unknownRun(t, contextSnapshot);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      const expected = (await resolveLedgerScopeForRun(db, t.companyId, run)).projectId;
      const [row] = await db
        .select({ p: ledgerProjectIdOfRunSql(heartbeatRuns) })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, id));
      expect(row.p ?? null).toBe(expected ?? null);
    }
  });
});
