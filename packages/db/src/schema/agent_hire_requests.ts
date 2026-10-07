import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agentHireRequests = pgTable(
  "agent_hire_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    // Keep the identity after deletion so a retry cannot silently hire a replacement.
    agentId: uuid("agent_id"),
    approvalId: uuid("approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("agent_hire_requests_company_key_unique_idx")
      .on(table.companyId, table.idempotencyKey),
  }),
);
