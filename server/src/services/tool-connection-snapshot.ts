import { getTableColumns, sql } from "drizzle-orm";
import { toolConnections } from "@paperclipai/db";
import { exactTimestampRevision, type ExactTimestampRevision } from "./exact-timestamp-revision.js";

/** Atomically capture the row and exact instant; same incumbent format as agent-action-audit. */
export const toolConnectionSnapshotColumns = {
  ...getTableColumns(toolConnections),
  updatedAtExact: sql<string>`to_char(${toolConnections.updatedAt} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("updated_at_exact"),
};

/** Do not truncate the column, add tolerance, or substitute a later DB observation. */
export function exactConnectionUpdatedAtPredicate(row: ExactTimestampRevision) {
  return sql`${toolConnections.updatedAt} = ${exactTimestampRevision(row)}::timestamptz`;
}
