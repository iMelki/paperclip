import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agentInstances } from "./agent_instances.js";

export const taskParticipations = pgTable(
  "task_participations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    runtime: text("runtime").notNull(),
    role: text("role").notNull().default("worker"),
    mode: text("mode").notNull().default("mutate"),
    enforcementMode: text("enforcement_mode").notNull().default("observe"),
    runId: text("run_id"),
    sessionId: text("session_id"),
    currentAction: text("current_action"),
    progressNote: text("progress_note"),
    blocker: text("blocker"),
    nextAction: text("next_action"),
    retryState: jsonb("retry_state").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("task_participations_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
    issueLastSeenIdx: index("task_participations_issue_last_seen_idx").on(
      table.issueId,
      table.lastSeenAt,
    ),
  }),
);
