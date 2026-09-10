import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0197_coordination_lease_credentials.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("coordination lease credential migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("hashes legacy bearer tokens and creates a durable claim idempotency ledger", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-coordination-credential-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP TABLE IF EXISTS "coordination_claim_idempotency_keys"`;
    await sql`DROP INDEX IF EXISTS "mutation_leases_token_hash_uq"`;
    await sql`ALTER TABLE "mutation_leases" ADD COLUMN "lease_token" text`;
    await sql`ALTER TABLE "mutation_leases" DROP COLUMN "lease_token_hash"`;
    await sql`ALTER TABLE "mutation_leases" ADD CONSTRAINT "mutation_leases_lease_token_unique" UNIQUE ("lease_token")`;
    await sql`CREATE INDEX "mutation_leases_token_idx" ON "mutation_leases" ("lease_token")`;

    const companyId = randomUUID();
    const issueId = randomUUID();
    const participationId = randomUUID();
    const leaseId = randomUUID();
    const plaintextToken = "legacy-plaintext-lease-token";
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Coordination', ${`C${companyId.slice(0, 6)}`})`;
    await sql`INSERT INTO "issues" ("id", "company_id", "title") VALUES (${issueId}, ${companyId}, 'Coordinate work')`;
    await sql`
      INSERT INTO "task_participations" ("id", "company_id", "issue_id", "runtime")
      VALUES (${participationId}, ${companyId}, ${issueId}, 'codex-desktop')
    `;
    await sql`
      INSERT INTO "mutation_leases" (
        "id", "company_id", "issue_id", "task_participation_id", "lease_token",
        "holder_agent_id", "work_unit_id", "scope_repositories", "scope_paths", "expires_at"
      ) VALUES (
        ${leaseId}, ${companyId}, ${issueId}, ${participationId}, ${plaintextToken},
        'agent-1', 'work-1', '["iMelki/paperclip"]'::jsonb,
        '["server/src/services/coordination.ts"]'::jsonb, now() + interval '1 hour'
      )
    `;
    await sql`ALTER TABLE "mutation_leases" ALTER COLUMN "lease_token" SET NOT NULL`;

    await applyPendingMigrations(database.connectionString);

    const columns = await sql<{ column_name: string }[]>`
      SELECT "column_name" FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "table_name" = 'mutation_leases'
    `;
    const columnNames = columns.map((row) => row.column_name);
    expect(columnNames).toContain("lease_token_hash");
    expect(columnNames).not.toContain("lease_token");

    const [lease] = await sql<{ lease_token_hash: string }[]>`
      SELECT "lease_token_hash" FROM "mutation_leases" WHERE "id" = ${leaseId}
    `;
    expect(lease?.lease_token_hash).toBe(createHash("sha256").update(plaintextToken).digest("hex"));
    expect(lease?.lease_token_hash).not.toContain(plaintextToken);

    const idempotencyId = randomUUID();
    await sql`
      INSERT INTO "coordination_claim_idempotency_keys" (
        "id", "company_id", "idempotency_key", "request_hash", "mutation_lease_id",
        "task_participation_id", "status", "response_status", "response_body", "expires_at"
      ) VALUES (
        ${idempotencyId}, ${companyId}, 'claim-1', ${"a".repeat(64)}, ${leaseId},
        ${participationId}, 'completed', 200, '{"leaseId":"safe-to-cache"}'::jsonb,
        now() + interval '72 hours'
      )
    `;
    await expect(sql`
      INSERT INTO "coordination_claim_idempotency_keys" (
        "company_id", "idempotency_key", "request_hash", "expires_at"
      ) VALUES (${companyId}, 'claim-1', ${"b".repeat(64)}, now() + interval '72 hours')
    `).rejects.toMatchObject({ code: "23505" });
    await expect(sql`
      INSERT INTO "coordination_claim_idempotency_keys" (
        "company_id", "idempotency_key", "request_hash"
      ) VALUES (${companyId}, 'claim-invalid-hash', 'not-a-sha256-hash')
    `).rejects.toMatchObject({ code: "23514" });
  }, 30_000);
});
