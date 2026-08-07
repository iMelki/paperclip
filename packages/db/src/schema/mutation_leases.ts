import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { taskParticipations } from "./task_participations.js";

export const mutationLeases = pgTable(
  "mutation_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    taskParticipationId: uuid("task_participation_id").references(() => taskParticipations.id, { onDelete: "set null" }),
    leaseTokenHash: text("lease_token_hash").notNull(),
    holderAgentId: text("holder_agent_id").notNull(),
    workUnitId: text("work_unit_id").notNull(),
    scopeRepositories: jsonb("scope_repositories").$type<string[]>().notNull(),
    scopePaths: jsonb("scope_paths").$type<string[]>().notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueStatusIdx: index("mutation_leases_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    tokenHashIdx: uniqueIndex("mutation_leases_token_hash_uq").on(table.leaseTokenHash),
    tokenHashFormatCheck: check(
      "mutation_leases_token_hash_format_check",
      sql`${table.leaseTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
