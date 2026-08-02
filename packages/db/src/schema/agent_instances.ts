import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { hostNodes } from "./host_nodes.js";

export const agentInstances = pgTable(
  "agent_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    runtime: text("runtime").notNull(),
    role: text("role").notNull().default("worker"),
    mode: text("mode").notNull().default("mutate"),
    enforcementMode: text("enforcement_mode").notNull().default("observe"),
    hostNodeId: uuid("host_node_id").references(() => hostNodes.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_instances_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
  }),
);
