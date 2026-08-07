import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mutationLeases } from "./mutation_leases.js";
import { taskParticipations } from "./task_participations.js";

/**
 * Durable request ledger for the future coordination claim endpoint.
 *
 * responseBody must contain only non-secret response facts. A successful retry
 * can reuse the lease/participation identity and rotate a fresh bearer token;
 * plaintext lease credentials must never be cached in this table.
 */
export const coordinationClaimIdempotencyKeys = pgTable(
  "coordination_claim_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("processing"),
    mutationLeaseId: uuid("mutation_lease_id").references(() => mutationLeases.id, { onDelete: "set null" }),
    taskParticipationId: uuid("task_participation_id").references(() => taskParticipations.id, { onDelete: "set null" }),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '72 hours'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("coordination_claim_idempotency_keys_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    expiryIdx: index("coordination_claim_idempotency_keys_expires_at_idx").on(table.expiresAt),
    leaseIdx: index("coordination_claim_idempotency_keys_lease_idx").on(table.mutationLeaseId),
    requestHashFormatCheck: check(
      "coordination_claim_idempotency_keys_request_hash_format_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
