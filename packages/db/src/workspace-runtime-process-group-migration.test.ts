import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0198_workspace_runtime_service_process_group.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("workspace runtime process-group migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("leaves legacy wrapper PIDs null without platform and group-custody provenance", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-process-group-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "workspace_runtime_services" DROP COLUMN "process_group_id"`;

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Runtime migration', ${`R${companyId.slice(0, 6)}`})`;
    const activeId = randomUUID();
    const stoppedId = randomUUID();
    const opaqueId = randomUUID();
    await sql`
      INSERT INTO "workspace_runtime_services" (
        "id", "company_id", "scope_type", "service_name", "status", "lifecycle",
        "provider", "provider_ref", "health_status"
      ) VALUES
        (${activeId}, ${companyId}, 'agent', 'active-local', 'running', 'shared', 'local_process', '4242', 'healthy'),
        (${stoppedId}, ${companyId}, 'agent', 'stopped-local', 'stopped', 'shared', 'local_process', '4343', 'unknown'),
        (${opaqueId}, ${companyId}, 'agent', 'opaque-local', 'failed', 'shared', 'local_process', 'not-a-pid', 'unhealthy')
    `;

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{ id: string; process_group_id: number | null }[]>`
      SELECT "id", "process_group_id"
      FROM "workspace_runtime_services"
      WHERE "id" IN (${activeId}, ${stoppedId}, ${opaqueId})
      ORDER BY "id"
    `;
    const byId = new Map(rows.map((row) => [row.id, row.process_group_id]));
    expect(byId.get(activeId)).toBeNull();
    expect(byId.get(stoppedId)).toBeNull();
    expect(byId.get(opaqueId)).toBeNull();
  }, 30_000);
});
