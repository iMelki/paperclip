import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolCatalogReviewService } from "../services/tool-catalog-review.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tool catalog review service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-tool-catalog-review-",
    );
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCatalog() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Catalog review ${randomUUID()}`,
        issuePrefix: `CR${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    const [application] = await db
      .insert(toolApplications)
      .values({
        companyId: company!.id,
        applicationKey: `catalog-${randomUUID()}`,
        name: "Catalog review app",
        type: "mcp_http",
        status: "active",
      })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId: company!.id,
        applicationId: application!.id,
        name: "Catalog review connection",
        uid: `catalog/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { quarantineNewEntries: true },
        transportConfig: { url: "https://example.test/mcp" },
      })
      .returning();
    const hashes = [
      { versionHash: "a".repeat(64), schemaHash: "b".repeat(64) },
      { versionHash: "c".repeat(64), schemaHash: "d".repeat(64) },
    ];
    const catalog = await db
      .insert(toolCatalogEntries)
      .values(hashes.map((hash, index) => ({
        companyId: company!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        name: `tool_${index}`,
        toolName: `tool_${index}`,
        entryKind: "tool" as const,
        status: "quarantined" as const,
        versionHash: hash.versionHash,
        schemaHash: hash.schemaHash,
        quarantinedAt: new Date(),
        quarantineReason: "pending_review",
      })))
      .returning();
    return {
      company: company!,
      application: application!,
      connection: connection!,
      catalog,
    };
  }

  it("activates only selected entries and keeps explicit denials quarantined in one transaction", async () => {
    const seeded = await seedCatalog();
    const beforeProfileCount = await db
      .select()
      .from(toolProfiles)
      .then((rows) => rows.length);

    const result = await toolCatalogReviewService(db).reviewConnectionCatalog({
      companyId: seeded.company.id,
      connectionId: seeded.connection.id,
      body: {
        decisions: [
          {
            catalogEntryId: seeded.catalog[0]!.id,
            decision: "activate",
            expectedVersionHash: seeded.catalog[0]!.versionHash,
            expectedSchemaHash: seeded.catalog[0]!.schemaHash!,
          },
          {
            catalogEntryId: seeded.catalog[1]!.id,
            decision: "keep_quarantined",
            expectedVersionHash: seeded.catalog[1]!.versionHash,
            expectedSchemaHash: seeded.catalog[1]!.schemaHash!,
          },
        ],
      },
      actor: { actorType: "user", actorId: "catalog-reviewer" },
    });

    expect(result).toMatchObject({
      activatedCount: 1,
      keptQuarantinedCount: 1,
      unchangedCount: 0,
    });
    const rows = await db
      .select()
      .from(toolCatalogEntries)
      .orderBy(asc(toolCatalogEntries.toolName));
    expect(rows.map((row) => ({
      status: row.status,
      reviewedByUserId: row.reviewedByUserId,
      quarantineReason: row.quarantineReason,
    }))).toEqual([
      {
        status: "active",
        reviewedByUserId: "catalog-reviewer",
        quarantineReason: null,
      },
      {
        status: "quarantined",
        reviewedByUserId: "catalog-reviewer",
        quarantineReason: "catalog_review_kept_quarantined",
      },
    ]);
    expect(await db.select().from(toolProfiles).then((rows) => rows.length))
      .toBe(beforeProfileCount);
    expect(await db.select().from(toolAccessAuditEvents))
      .toHaveLength(2);
  });

  it("accepts exact reviewed replays without rewriting catalog state", async () => {
    const seeded = await seedCatalog();
    const service = toolCatalogReviewService(db);
    const body = {
      decisions: [{
        catalogEntryId: seeded.catalog[0]!.id,
        decision: "activate" as const,
        expectedVersionHash: seeded.catalog[0]!.versionHash,
        expectedSchemaHash: seeded.catalog[0]!.schemaHash!,
      }],
    };
    await service.reviewConnectionCatalog({
      companyId: seeded.company.id,
      connectionId: seeded.connection.id,
      body,
      actor: { actorType: "user", actorId: "catalog-reviewer" },
    });
    const before = await db
      .select()
      .from(toolCatalogEntries)
      .where(eq(toolCatalogEntries.id, seeded.catalog[0]!.id))
      .then((rows) => rows[0]!);

    const replay = await service.reviewConnectionCatalog({
      companyId: seeded.company.id,
      connectionId: seeded.connection.id,
      body,
      actor: { actorType: "user", actorId: "another-reviewer" },
    });
    const after = await db
      .select()
      .from(toolCatalogEntries)
      .where(eq(toolCatalogEntries.id, seeded.catalog[0]!.id))
      .then((rows) => rows[0]!);

    expect(replay).toMatchObject({
      activatedCount: 0,
      keptQuarantinedCount: 0,
      unchangedCount: 1,
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.reviewedByUserId).toBe("catalog-reviewer");
  });

  it("rolls back the whole batch when any hash precondition drifts", async () => {
    const seeded = await seedCatalog();

    await expect(
      toolCatalogReviewService(db).reviewConnectionCatalog({
        companyId: seeded.company.id,
        connectionId: seeded.connection.id,
        body: {
          decisions: [
            {
              catalogEntryId: seeded.catalog[0]!.id,
              decision: "activate",
              expectedVersionHash: seeded.catalog[0]!.versionHash,
              expectedSchemaHash: seeded.catalog[0]!.schemaHash!,
            },
            {
              catalogEntryId: seeded.catalog[1]!.id,
              decision: "activate",
              expectedVersionHash: "f".repeat(64),
              expectedSchemaHash: seeded.catalog[1]!.schemaHash!,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "catalog_review_precondition_failed" },
    });

    const rows = await db
      .select()
      .from(toolCatalogEntries)
      .orderBy(asc(toolCatalogEntries.toolName));
    expect(rows.map((row) => row.status)).toEqual([
      "quarantined",
      "quarantined",
    ]);
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(0);
  });

  it("rejects catalog entries from another connection before any review writes", async () => {
    const first = await seedCatalog();
    const second = await seedCatalog();

    await expect(
      toolCatalogReviewService(db).reviewConnectionCatalog({
        companyId: first.company.id,
        connectionId: first.connection.id,
        body: {
          decisions: [{
            catalogEntryId: second.catalog[0]!.id,
            decision: "activate",
            expectedVersionHash: second.catalog[0]!.versionHash,
            expectedSchemaHash: second.catalog[0]!.schemaHash!,
          }],
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "catalog_review_precondition_failed" },
    });
  });
});
