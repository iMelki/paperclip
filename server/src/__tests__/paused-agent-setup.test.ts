import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import { PAUSED_AGENT_SETUP_KEY } from "@paperclipai/shared";
import { agentService } from "../services/agents.js";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Paused setup Postgres tests skipped: ${support.reason}`);

// Real service/database integration, using the repository's existing isolated
// fixture. No adapter execution, scheduler, heartbeat worker or HTTP server runs.
describePostgres("paused setup approval remains inert", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-paused-setup-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(pausedSetup = true) {
    const [company] = await db.insert(companies).values({
      name: "Paused setup test company",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: true,
    }).returning();
    // Seed the pending record independently of the helper under test: its
    // expected safety properties must not be derived from its own output.
    const [pending] = await db.insert(agents).values({
      companyId: company.id,
      name: pausedSetup ? "Finance setup" : "Ordinary pending hire",
      role: "general",
      status: "pending_approval",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnDemand: false,
        wakeOnAssignment: false,
        wakeOnOnDemand: false,
        wakeOnAutomation: false,
        maxConcurrentRuns: 1,
      } },
      defaultEnvironmentId: null,
      permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
      metadata: pausedSetup
        ? { [PAUSED_AGENT_SETUP_KEY]: true, purpose: "finance-draft" }
        : { purpose: "ordinary-hire" },
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }).returning();
    return { company, pending, service: agentService(db) };
  }

  async function expectNoExecutionOrSecrets(companyId: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(runs).toHaveLength(0);
    expect(wakes).toHaveLength(0);
    expect(bindings).toHaveLength(0);
    expect(secrets).toHaveLength(0);
  }

  async function expectPersistedInert(agentId: string, companyId: string) {
    // Read the saved row directly, independently of the service response.
    const saved = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(saved).toHaveLength(1);
    const row = saved[0]!;
    expect(row.status).toBe("paused");
    expect(row.pauseReason).toBe("manual");
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.adapterType).toBe("process");
    expect(row.adapterConfig).toEqual({});
    expect(row.defaultEnvironmentId).toBeNull();
    expect(row.permissions).toEqual({
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    });
    expect(row.runtimeConfig).toEqual({ heartbeat: {
      enabled: false,
      intervalSec: 0,
      wakeOnDemand: false,
      wakeOnAssignment: false,
      wakeOnOnDemand: false,
      wakeOnAutomation: false,
      maxConcurrentRuns: 1,
    } });
    expect(row.metadata).toEqual({ [PAUSED_AGENT_SETUP_KEY]: true, purpose: "finance-draft" });
    expect(row.lastHeartbeatAt).toBeNull();
    await expectNoExecutionOrSecrets(companyId);
    return row;
  }

  it("service resume and status update refuse an unconfigured paused setup, then allow it once configured", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, f.pending.id));
    await expect(f.service.resume(f.pending.id)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.update(f.pending.id, { status: "idle" })).rejects.toMatchObject({ status: 409 });
    const [row] = await db.select().from(agents).where(eq(agents.id, f.pending.id));
    expect(row!.status).toBe("paused");
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: "echo" } }).where(eq(agents.id, f.pending.id));
    await expect(f.service.resume(f.pending.id)).resolves.toMatchObject({ status: "idle" });
  });

  it("keeps a marked pending setup paused after approval with a normal snapshot", async () => {
    const f = await fixture();
    const result = await f.service.activatePendingApproval(f.pending.id, {
      name: f.pending.name,
      role: f.pending.role,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: { purpose: "approval-snapshot-without-marker" },
    });
    expect(result).toMatchObject({ activated: true, agent: { id: f.pending.id, status: "paused" } });
    await expectPersistedInert(f.pending.id, f.company.id);
  });

  it.each(["omitted", "null"] as const)(
    "keeps a marked pending setup paused through the %s-payload fallback",
    async (payloadMode) => {
      const f = await fixture();
      const result = payloadMode === "null"
        ? await f.service.activatePendingApproval(f.pending.id, null)
        : await f.service.activatePendingApproval(f.pending.id);
      expect(result).toMatchObject({ activated: true, agent: { id: f.pending.id, status: "paused" } });
      await expectPersistedInert(f.pending.id, f.company.id);
    },
  );

  it("discards approved commands, env, environment, permissions and every wake alias", async () => {
    const f = await fixture();
    const [environment] = await db.insert(environments).values({
      name: `Approval-only fixture ${randomUUID()}`,
      driver: "sandbox",
      config: {},
    }).returning();
    const result = await f.service.activatePendingApproval(f.pending.id, {
      adapterType: "codex_local",
      adapterConfig: {
        command: "fixture-command-must-never-run",
        args: ["fixture-argument"],
        env: { REVIEW_SENTINEL: { type: "plain", value: "must-not-persist" } },
      },
      defaultEnvironmentId: environment!.id,
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 1,
          wakeOnDemand: true,
          wakeOnAssignment: true,
          wakeOnOnDemand: true,
          wakeOnAutomation: true,
          maxConcurrentRuns: 9,
        },
        modelProfiles: { default: "fixture-provider-must-not-be-selected" },
      },
      permissions: {
        canCreateAgents: true,
        canCreateSkills: true,
        canAssignTasks: true,
        canManageCompany: true,
      },
      metadata: { [PAUSED_AGENT_SETUP_KEY]: false, purpose: "hostile-snapshot" },
    });
    expect(result).toMatchObject({ activated: true, agent: { id: f.pending.id, status: "paused" } });
    const row = await expectPersistedInert(f.pending.id, f.company.id);
    expect(JSON.stringify(row)).not.toContain("must-not-persist");
    expect(JSON.stringify(row)).not.toContain("fixture-command-must-never-run");
    expect(JSON.stringify(row)).not.toContain("fixture-provider-must-not-be-selected");
  });

  it("reasserts inert settings on payload-free approval even if the pending row drifted", async () => {
    const f = await fixture();
    await db.update(agents).set({
      adapterType: "process",
      adapterConfig: { command: "stale-fixture-command" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1, wakeOnDemand: true } },
      permissions: { canCreateAgents: true, canCreateSkills: true, canAssignTasks: true },
    }).where(eq(agents.id, f.pending.id));

    const result = await f.service.activatePendingApproval(f.pending.id);
    expect(result).toMatchObject({ activated: true, agent: { status: "paused" } });
    await expectPersistedInert(f.pending.id, f.company.id);
  });

  it("does not reactivate a paused setup when the same approval is repeated", async () => {
    const f = await fixture();
    await f.service.activatePendingApproval(f.pending.id);
    const before = await expectPersistedInert(f.pending.id, f.company.id);
    const replay = await f.service.activatePendingApproval(f.pending.id, {
      adapterConfig: { command: "replay-must-not-run" },
      permissions: { canCreateAgents: true, canCreateSkills: true },
    });
    expect(replay).toMatchObject({ activated: false, agent: { status: "paused" } });
    const after = await expectPersistedInert(f.pending.id, f.company.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.pausedAt).toEqual(before.pausedAt);
  });

  it("still activates an ordinary pending hire and applies its approved configuration", async () => {
    const f = await fixture(false);
    const result = await f.service.activatePendingApproval(f.pending.id, {
      name: "Approved ordinary hire",
      adapterType: "process",
      adapterConfig: { command: "ordinary-fixture-command" },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } },
      permissions: { canCreateAgents: false, canCreateSkills: true },
    });
    expect(result).toMatchObject({ activated: true, agent: { status: "idle" } });
    const [row] = await db.select().from(agents).where(eq(agents.id, f.pending.id));
    expect(row).toMatchObject({
      status: "idle",
      name: "Approved ordinary hire",
      adapterType: "process",
      adapterConfig: { command: "ordinary-fixture-command" },
      permissions: { canCreateAgents: false, canCreateSkills: true },
      metadata: { purpose: "ordinary-hire" },
    });
    expect(row!.metadata?.[PAUSED_AGENT_SETUP_KEY]).toBeUndefined();
    await expectNoExecutionOrSecrets(f.company.id);
  });

  it("still activates an ordinary pending hire through the payload-free fallback", async () => {
    const f = await fixture(false);
    const result = await f.service.activatePendingApproval(f.pending.id);
    expect(result).toMatchObject({ activated: true, agent: { id: f.pending.id, status: "idle" } });
    const [row] = await db.select().from(agents).where(eq(agents.id, f.pending.id));
    expect(row!.status).toBe("idle");
    expect(row!.adapterConfig).toEqual({});
    expect(row!.metadata).toEqual({ purpose: "ordinary-hire" });
    await expectNoExecutionOrSecrets(f.company.id);
  });
});
