import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const hostNodes = pgTable(
  "host_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    hostId: text("host_id").notNull().unique(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    runtime: text("runtime").notNull(),
    reachableAddresses: jsonb("reachable_addresses").$type<string[]>(),
    environment: text("environment"),
    systemTelemetry: jsonb("system_telemetry").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("online"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyHostStatusIdx: index("host_nodes_company_host_status_idx").on(
      table.companyId,
      table.hostId,
      table.status,
    ),
  }),
);
