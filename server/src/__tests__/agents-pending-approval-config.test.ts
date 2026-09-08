import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
  environments,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { redactHireApprovalConfigForPersistence } from "../services/hire-approval-payload.ts";
import { REDACTED_EVENT_VALUE } from "../redaction.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pauseApprovalUpdateBeforeReturning(
  source: ReturnType<typeof createDb>,
  reachedUpdate: ReturnType<typeof deferred>,
  releaseUpdate: ReturnType<typeof deferred>,
) {
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property !== "update") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (table: unknown) => {
        const update = target.update.bind(target) as (targetTable: unknown) => {
          set: (values: unknown) => {
            where: (condition: unknown) => {
              returning: () => Promise<unknown[]>;
            };
          };
        };
        const builder = update(table);
        if (table !== approvals) return builder;
        return {
          set(values: unknown) {
            const setBuilder = builder.set(values);
            return {
              where(condition: unknown) {
                const whereBuilder = setBuilder.where(condition);
                return {
                  async returning() {
                    reachedUpdate.resolve();
                    await releaseUpdate.promise;
                    return whereBuilder.returning();
                  },
                };
              },
            };
          },
        };
      };
    },
  }) as ReturnType<typeof createDb>;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("preserves the empty Codex API key and reapplies the frozen approval snapshot", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "codex_local",
      adapterConfig: {
        command: "echo safe",
        env: { OPENAI_API_KEY: { type: "plain", value: "" } },
      },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "codex_local",
        adapterConfig: redactHireApprovalConfigForPersistence({
          command: "echo safe",
          env: { OPENAI_API_KEY: { type: "plain", value: "" } },
        }),
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    expect(approval.payload).toMatchObject({
      permissions: {
        canCreateAgents: false,
        canCreateSkills: true,
      },
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "codex_local",
      adapterConfig: {
        command: "echo safe",
        env: { OPENAI_API_KEY: { type: "plain", value: "" } },
      },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      permissions: {
        canCreateAgents: false,
        canCreateSkills: true,
      },
    });
  });

  it("rejects a permission snapshot that differs from the pending agent", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Frozen Permissions",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: { canCreateAgents: false, canCreateSkills: true },
      lastHeartbeatAt: null,
    });

    await expect(approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: "requester-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        agentId: pending.id,
        name: pending.name,
        role: pending.role,
        adapterType: pending.adapterType,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true, canCreateSkills: true },
      },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_permission_baseline_mismatch",
        path: "permissions",
      },
    });
    const persistedApprovals = await db.select().from(approvals)
      .where(eq(approvals.companyId, companyId));
    expect(persistedApprovals).toHaveLength(0);
  });

  it("persists redacted pending-baseline secrets across create and resubmit, then restores them", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Baseline Custodian",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          EMPTY_API_KEY: { type: "plain", value: "" },
          NONEMPTY_API_KEY: { type: "plain", value: "sk-persisted" },
          WHITESPACE_API_KEY: { type: "plain", value: "   " },
        },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const rawPayload = {
      name: pending.name,
      role: pending.role,
      adapterType: pending.adapterType,
      adapterConfig: pending.adapterConfig as Record<string, unknown>,
      runtimeConfig: pending.runtimeConfig,
      budgetMonthlyCents: 0,
      agentId: pending.id,
    };
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: rawPayload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    const [createdRow] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(createdRow?.payload).toMatchObject({
      adapterConfig: {
        env: {
          EMPTY_API_KEY: { type: "plain", value: "" },
          NONEMPTY_API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
          WHITESPACE_API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
        },
      },
    });
    expect(JSON.stringify(createdRow?.payload)).not.toContain("sk-persisted");
    const persistedPayload = createdRow?.payload as Record<string, unknown>;

    await approvalSvc.requestRevision(approval.id, "board-user", "Recheck persistence");
    await approvalSvc.resubmit(approval.id, persistedPayload);
    const [resubmittedRow] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(resubmittedRow?.payload).toEqual(persistedPayload);
    expect(JSON.stringify(resubmittedRow?.payload)).not.toContain("sk-persisted");

    await approvalSvc.approve(approval.id, "board-user", "Approve restored baseline");
    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      adapterConfig: {
        env: {
          EMPTY_API_KEY: { type: "plain", value: "" },
          NONEMPTY_API_KEY: { type: "plain", value: "sk-persisted" },
          WHITESPACE_API_KEY: { type: "plain", value: "   " },
        },
      },
    });
  });

  it("persists an exact-empty no-baseline hire without creating an unrecoverable payload", async () => {
    const companyId = await seedCompany();
    const approvalSvc = approvalService(db);
    const rawPayload = {
      name: "Native Auth",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
        },
      },
      budgetMonthlyCents: 0,
    };
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: rawPayload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    const [persisted] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(persisted?.payload).toMatchObject({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
        },
      },
    });

    const result = await approvalSvc.approve(approval.id, "board-user", "Approve native auth");
    expect(result.applied).toBe(true);
    const createdAgentId = (result.approval.payload as { agentId?: string }).agentId;
    expect(createdAgentId).toBeUndefined();
    const createdAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.adapterConfig).toMatchObject({
      env: {
        OPENAI_API_KEY: { type: "plain", value: "" },
      },
    });
  });

  it.each([
    ["nonempty", "sk-live"],
    ["whitespace", "   "],
  ])("rejects a %s no-baseline secret without persisting an approval", async (_case, value) => {
    const companyId = await seedCompany();
    const approvalSvc = approvalService(db);

    await expect(
      approvalSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: "board-user",
        status: "pending",
        payload: {
          name: "Unsafe hire",
          role: "engineer",
          adapterType: "codex_local",
          adapterConfig: {
            env: {
              OPENAI_API_KEY: { type: "plain", value },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_secret_baseline_required",
        path: "adapterConfig.env.OPENAI_API_KEY.value",
      },
    });
    const persisted = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    expect(persisted).toHaveLength(0);
  });

  it.each([
    ["missing", null],
    ["cross-company", "other-company"],
  ])("rejects a %s pending baseline without persisting an approval", async (_case, mode) => {
    const companyId = await seedCompany();
    const approvalSvc = approvalService(db);
    let agentId = randomUUID();
    if (mode === "other-company") {
      const otherCompanyId = await seedCompany();
      const otherAgent = await agentService(db).create(otherCompanyId, {
        name: "Other tenant pending",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        status: "pending_approval",
        spentMonthlyCents: 0,
        permissions: {},
        lastHeartbeatAt: null,
      });
      agentId = otherAgent.id;
    }

    await expect(
      approvalSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: "board-user",
        status: "pending",
        payload: {
          agentId,
          adapterConfig: {},
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_pending_agent_mismatch",
        companyId,
        agentId,
      },
    });
    const persisted = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    expect(persisted).toHaveLength(0);
  });

  it("rolls approval, activation, and budget back together when budget persistence fails", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Transactional Codex",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: { OPENAI_API_KEY: { type: "plain", value: "" } },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 4321,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: pending.name,
        role: pending.role,
        adapterType: pending.adapterType,
        adapterConfig: redactHireApprovalConfigForPersistence(
          pending.adapterConfig as Record<string, unknown>,
        ),
        runtimeConfig: pending.runtimeConfig,
        budgetMonthlyCents: 4321,
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    const suffix = randomUUID().replace(/-/g, "");
    const functionName = `test_hire_budget_fn_${suffix}`;
    const triggerName = `test_hire_budget_tr_${suffix}`;
    try {
      await db.execute(sql.raw(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'forced hire budget failure';
        END;
        $$ LANGUAGE plpgsql
      `));
      try {
        await db.execute(sql.raw(`
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT OR UPDATE ON budget_policies
          FOR EACH ROW EXECUTE FUNCTION ${functionName}()
        `));
        await expect(
          approvalSvc.approve(approval.id, "board-user", "Approve atomically"),
        ).rejects.toMatchObject({
          cause: {
            code: "P0001",
            message: "forced hire budget failure",
          },
        });
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON budget_policies`));
      }
    } finally {
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }

    const [reloadedApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    const reloadedAgent = await agentSvc.getById(pending.id);
    const persistedBudgets = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, pending.id));

    expect(reloadedApproval?.status).toBe("pending");
    expect(reloadedApproval?.decidedAt).toBeNull();
    expect(reloadedAgent).toMatchObject({
      status: "pending_approval",
      adapterConfig: {
        env: { OPENAI_API_KEY: { type: "plain", value: "" } },
      },
    });
    expect(persistedBudgets).toHaveLength(0);
  });

  it("applies the complete standalone CEO snapshot without broadening restrictive permissions", async () => {
    const companyId = await seedCompany();
    const environmentId = randomUUID();
    await db.insert(environments).values({
      id: environmentId,
      name: `Approval environment ${environmentId}`,
      driver: "ssh",
      config: {},
      envVars: {},
    });
    const runtimeConfig = {
      heartbeat: { maxConcurrentRuns: 2 },
      modelProfiles: { cheap: { enabled: false, adapterConfig: {} } },
    };
    const permissions = {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    };
    const approvalSvc = approvalService(db);
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Restricted CEO",
        role: "ceo",
        icon: "code",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig,
        defaultEnvironmentId: environmentId,
        permissions,
      },
    });

    const result = await approvalSvc.approve(approval.id, "board-user", "Approve exact snapshot");
    const [created] = await db.select().from(agents).where(eq(agents.companyId, companyId));

    expect(result.applied).toBe(true);
    expect(created).toMatchObject({
      icon: "code",
      runtimeConfig,
      defaultEnvironmentId: environmentId,
      permissions,
    });
    expect(created.permissions).toEqual(permissions);
  });

  it("lets an approved decision win over a stale resubmit at the database compare-and-set", async () => {
    const companyId = await seedCompany();
    const approval = await approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "revision_requested",
      payload: {
        name: "Single Winner",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: { canCreateAgents: false, canCreateSkills: false },
      },
    });
    const reachedUpdate = deferred();
    const releaseUpdate = deferred();
    const blockedDb = pauseApprovalUpdateBeforeReturning(db, reachedUpdate, releaseUpdate);
    const secondConnection = createDb(tempDb!.connectionString);
    try {
      const resubmitOutcome = approvalService(blockedDb)
        .resubmit(approval.id)
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );

      await reachedUpdate.promise;
      const approveResult = await approvalService(secondConnection)
        .approve(approval.id, "board-user", "Approve while stale writer is paused");
      releaseUpdate.resolve();
      const staleResult = await resubmitOutcome;
      const [reloadedApproval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.id));
      const createdAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));

      expect(approveResult.applied).toBe(true);
      expect(staleResult.value).toBeNull();
      expect(staleResult.error).toMatchObject({
        status: 422,
        details: {
          code: "approval_resubmit_not_applied",
          approvalId: approval.id,
        },
      });
      expect(reloadedApproval.status).toBe("approved");
      expect(createdAgents).toHaveLength(1);
    } finally {
      releaseUpdate.resolve();
      await secondConnection.$client.end({ timeout: 0 });
    }
  });
});
