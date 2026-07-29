import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  toolAccessAuditEvents,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import type {
  ReviewToolConnectionCatalog,
  ToolCatalogEntry,
  ToolCatalogReviewResult,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

type ActorInfo = {
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
};

function toCatalogEntry(
  row: typeof toolCatalogEntries.$inferSelect,
): ToolCatalogEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    entryKind: row.entryKind,
    name: row.name,
    toolName: row.toolName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema ?? {},
    outputSchema: row.outputSchema ?? null,
    annotations: row.annotations ?? {},
    riskLevel: row.riskLevel,
    isReadOnly: row.isReadOnly,
    isWrite: row.isWrite,
    isDestructive: row.isDestructive,
    status: row.status,
    addedAt: row.firstSeenAt,
    version: row.version,
    versionHash: row.versionHash,
    schemaHash: row.schemaHash,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    reviewedAt: row.reviewedAt,
    reviewedByAgentId: row.reviewedByAgentId,
    reviewedByUserId: row.reviewedByUserId,
    quarantinedAt: row.quarantinedAt,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function preconditionConflict(
  message: string,
  details: Record<string, unknown>,
) {
  return conflict(message, {
    code: "catalog_review_precondition_failed",
    ...details,
  });
}

export function toolCatalogReviewService(db: Db) {
  return {
    async reviewConnectionCatalog(input: {
      companyId: string;
      connectionId: string;
      body: ReviewToolConnectionCatalog;
      actor?: ActorInfo;
    }): Promise<ToolCatalogReviewResult> {
      return db.transaction(async (tx) => {
        const [connection] = await tx
          .select()
          .from(toolConnections)
          .where(and(
            eq(toolConnections.id, input.connectionId),
            eq(toolConnections.companyId, input.companyId),
          ))
          .limit(1)
          .for("update");
        if (!connection) throw notFound("Tool connection not found");
        if (
          connection.status !== "active"
          || !connection.enabled
          || !["ok", "healthy"].includes(connection.healthStatus)
        ) {
          throw preconditionConflict(
            "Catalog review requires an active, enabled, healthy connection.",
            {
              connectionId: connection.id,
              status: connection.status,
              enabled: connection.enabled,
              healthStatus: connection.healthStatus,
            },
          );
        }

        const decisionIds = input.body.decisions.map(
          (decision) => decision.catalogEntryId,
        );
        const rows = await tx
          .select()
          .from(toolCatalogEntries)
          .where(and(
            eq(toolCatalogEntries.companyId, input.companyId),
            eq(toolCatalogEntries.connectionId, connection.id),
            inArray(toolCatalogEntries.id, decisionIds),
          ))
          .for("update");
        if (rows.length !== decisionIds.length) {
          throw preconditionConflict(
            "Catalog review entries must all belong to the requested connection.",
            {
              connectionId: connection.id,
              requestedCount: decisionIds.length,
              matchedCount: rows.length,
            },
          );
        }

        const rowsById = new Map(rows.map((row) => [row.id, row]));
        const failures: Array<Record<string, unknown>> = [];
        for (const decision of input.body.decisions) {
          const row = rowsById.get(decision.catalogEntryId)!;
          if (
            row.versionHash !== decision.expectedVersionHash
            || row.schemaHash !== decision.expectedSchemaHash
          ) {
            failures.push({
              catalogEntryId: row.id,
              reason: "hash_drift",
              expectedVersionHash: decision.expectedVersionHash,
              actualVersionHash: row.versionHash,
              expectedSchemaHash: decision.expectedSchemaHash,
              actualSchemaHash: row.schemaHash,
            });
            continue;
          }
          if (decision.decision === "activate") {
            if (
              row.status !== "quarantined"
              && !(row.status === "active" && row.reviewedAt !== null)
            ) {
              failures.push({
                catalogEntryId: row.id,
                reason: "invalid_status",
                status: row.status,
                reviewedAt: row.reviewedAt?.toISOString() ?? null,
              });
            }
          } else if (row.status !== "quarantined") {
            failures.push({
              catalogEntryId: row.id,
              reason: "invalid_status",
              status: row.status,
            });
          }
        }
        if (failures.length > 0) {
          throw preconditionConflict(
            "Catalog review preconditions changed; refresh and review again.",
            { connectionId: connection.id, failures },
          );
        }

        const now = new Date();
        let activatedCount = 0;
        let keptQuarantinedCount = 0;
        let unchangedCount = 0;
        for (const decision of input.body.decisions) {
          const current = rowsById.get(decision.catalogEntryId)!;
          let next = current;
          let unchanged = false;
          if (decision.decision === "activate") {
            if (current.status === "active") {
              unchanged = true;
            } else {
              [next] = await tx
                .update(toolCatalogEntries)
                .set({
                  status: "active",
                  reviewedAt: now,
                  reviewedByAgentId:
                    input.actor?.actorType === "agent"
                      ? input.actor.actorId ?? null
                      : null,
                  reviewedByUserId:
                    input.actor?.actorType === "user"
                      ? input.actor.actorId ?? null
                      : null,
                  quarantinedAt: null,
                  quarantineReason: null,
                  updatedAt: now,
                })
                .where(eq(toolCatalogEntries.id, current.id))
                .returning();
              activatedCount += 1;
            }
          } else {
            const alreadyReviewed =
              current.reviewedAt !== null
              && current.quarantineReason === "catalog_review_kept_quarantined";
            if (alreadyReviewed) {
              unchanged = true;
            } else {
              [next] = await tx
                .update(toolCatalogEntries)
                .set({
                  status: "quarantined",
                  reviewedAt: now,
                  reviewedByAgentId:
                    input.actor?.actorType === "agent"
                      ? input.actor.actorId ?? null
                      : null,
                  reviewedByUserId:
                    input.actor?.actorType === "user"
                      ? input.actor.actorId ?? null
                      : null,
                  quarantinedAt: current.quarantinedAt ?? now,
                  quarantineReason: "catalog_review_kept_quarantined",
                  updatedAt: now,
                })
                .where(eq(toolCatalogEntries.id, current.id))
                .returning();
              keptQuarantinedCount += 1;
            }
          }
          if (unchanged) unchangedCount += 1;
          rowsById.set(current.id, next);
          await tx.insert(toolAccessAuditEvents).values({
            companyId: input.companyId,
            connectionId: connection.id,
            catalogEntryId: current.id,
            actorType: input.actor?.actorType ?? "system",
            actorId: input.actor?.actorId ?? null,
            action: "tool_connection.catalog_review",
            outcome: "success",
            reasonCode: unchanged
              ? "catalog_review_idempotent_replay"
              : decision.decision === "activate"
                ? "catalog_entry_activated"
                : "catalog_entry_kept_quarantined",
            details: {
              decision: decision.decision,
              versionHash: current.versionHash,
              schemaHash: current.schemaHash,
              unchanged,
            },
          });
        }

        return {
          connectionId: connection.id,
          activatedCount,
          keptQuarantinedCount,
          unchangedCount,
          catalog: input.body.decisions.map((decision) =>
            toCatalogEntry(rowsById.get(decision.catalogEntryId)!),
          ),
        };
      });
    },
  };
}
