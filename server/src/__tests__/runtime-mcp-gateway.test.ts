import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolMcpGateways,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { ensureExactRuntimeMcpGateway } from "../services/runtime-mcp-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("exact runtime MCP gateway", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-runtime-mcp-gateway-",
    );
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedExactAccess() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Runtime gateway ${randomUUID()}`,
        issuePrefix: `RG${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Runtime Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    const [application] = await db
      .insert(toolApplications)
      .values({
        companyId: company!.id,
        applicationKey: `runtime-${randomUUID()}`,
        name: "Runtime MCP app",
        type: "mcp_http",
        status: "active",
      })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId: company!.id,
        applicationId: application!.id,
        name: "Runtime GitHub read",
        uid: `runtime/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { url: "https://example.test/mcp" },
      })
      .returning();
    const [catalog] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId: company!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        name: "issues_read",
        toolName: "issues_read",
        entryKind: "tool",
        status: "active",
        versionHash: "a".repeat(64),
        schemaHash: "b".repeat(64),
        reviewedAt: new Date(),
        quarantinedAt: null,
      })
      .returning();
    const [roleProfile] = await db
      .insert(toolProfiles)
      .values({
        companyId: company!.id,
        profileKey: `role:${randomUUID()}`,
        name: "Runtime Builder Read",
        status: "active",
        defaultAction: "deny",
      })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: roleProfile!.id,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: application!.id,
      connectionId: connection!.id,
      catalogEntryId: catalog!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: roleProfile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const effective = await toolAccessService(db).getEffectiveProfilesForAgent(
      company!.id,
      agent!.id,
    );
    return {
      company: company!,
      agent: agent!,
      connection: connection!,
      catalog: catalog!,
      roleProfile: roleProfile!,
      effective,
    };
  }

  function ensureInput(
    seeded: Awaited<ReturnType<typeof seedExactAccess>>,
    overrides: Partial<{
      configHash: string;
      issueId: string | null;
      projectId: string | null;
      routineId: string | null;
    }> = {},
  ) {
    return {
      db,
      companyId: seeded.company.id,
      agentId: seeded.agent.id,
      connection: seeded.connection,
      runContext: {
        issueId: overrides.issueId ?? null,
        projectId: overrides.projectId ?? null,
        routineId: overrides.routineId ?? null,
        taskRevisionHash: "task-revision",
        configHash: overrides.configHash ?? "config-one",
        installHash: "install-one",
      },
      sourceProfiles: seeded.effective.profiles.map((profile) => ({
        id: profile.id,
        updatedAt: profile.updatedAt,
      })),
      expectedTools: seeded.effective.allowedTools,
    };
  }

  it("materializes one immutable deny-by-default gateway with exact catalog selectors", async () => {
    const seeded = await seedExactAccess();
    const first = await ensureExactRuntimeMcpGateway(ensureInput(seeded));
    const replay = await ensureExactRuntimeMcpGateway(ensureInput(seeded));

    expect(replay.gateway.id).toBe(first.gateway.id);
    expect(replay.profile.id).toBe(first.profile.id);
    expect(replay).toMatchObject({
      createdGateway: false,
      createdProfile: false,
    });
    expect(first.gateway).toMatchObject({
      agentId: seeded.agent.id,
      profileId: first.profile.id,
      defaultProfileMode: "gateway_only",
    });
    expect(first.gateway.metadata).toMatchObject({
      source: "managed_runtime_exact",
      managedRuntimeAgentId: seeded.agent.id,
      managedRuntimeConnectionId: seeded.connection.id,
      effectiveCapabilitySha256: first.effectiveCapabilitySha256,
      catalogEntryIds: [seeded.catalog.id],
    });
    expect(first.profile.defaultAction).toBe("deny");

    const entries = await db
      .select()
      .from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, first.profile.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      selectorType: "catalog_entry",
      effect: "include",
      connectionId: seeded.connection.id,
      catalogEntryId: seeded.catalog.id,
    });
    expect(entries.some((entry) => entry.selectorType === "connection"))
      .toBe(false);
    expect(
      await db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.companyId, seeded.company.id)),
    ).toHaveLength(1);
  });

  it("rotates to a new immutable gateway when effective configuration changes", async () => {
    const seeded = await seedExactAccess();
    const first = await ensureExactRuntimeMcpGateway(ensureInput(seeded));
    const rotated = await ensureExactRuntimeMcpGateway(
      ensureInput(seeded, { configHash: "config-two" }),
    );

    expect(rotated.gateway.id).not.toBe(first.gateway.id);
    expect(rotated.profile.id).not.toBe(first.profile.id);
    expect(rotated.effectiveCapabilitySha256)
      .not.toBe(first.effectiveCapabilitySha256);
    expect(
      await db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.companyId, seeded.company.id)),
    ).toHaveLength(2);
  });

  it("fails atomically when a catalog hash changes after effective access was resolved", async () => {
    const seeded = await seedExactAccess();
    await db
      .update(toolCatalogEntries)
      .set({ versionHash: "f".repeat(64), updatedAt: new Date() })
      .where(eq(toolCatalogEntries.id, seeded.catalog.id));

    await expect(
      ensureExactRuntimeMcpGateway(ensureInput(seeded)),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "runtime_mcp_gateway_precondition_failed" },
    });
    expect(
      await db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.companyId, seeded.company.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(toolProfiles)
        .where(and(
          eq(toolProfiles.companyId, seeded.company.id),
          eq(toolProfiles.profileKey, seeded.roleProfile.profileKey),
        )),
    ).toHaveLength(1);
  });
});
