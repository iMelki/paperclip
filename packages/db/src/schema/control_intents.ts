import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agentInstances } from "./agent_instances.js";

export const controlIntents = pgTable(
  "control_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    targetWorkUnitId: text("target_work_unit_id"),
    targetAgentInstanceId: uuid("target_agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    intentType: text("intent_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("pending"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRootStatusIdx: index("control_intents_company_root_status_idx").on(
      table.companyId,
      table.rootIssueId,
      table.status,
    ),
  }),
);
