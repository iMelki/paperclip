import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workspaceRuntimeServices } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { insertRowsInChunks } from "./batch-insert.js";
import type { ImportIssueWorkProductRow } from "./import-write-types.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Refresh runtime-service work products from the live runtime rows they point at
 * (PAP-17572).
 *
 * A runtime URL is only valid for as long as the process holds that port. A
 * managed restart can relocate it, which used to leave a user-facing preview link
 * that answers with somebody else's service or nothing at all. The runtime row is
 * the authoritative publication record, so it wins over the stored copy.
 *
 * Read-path only and deliberately non-destructive: a work product whose runtime
 * row is gone keeps its recorded URL and is reported unhealthy rather than
 * silently blanked, so the history of what was published survives.
 */
export function reconcileRuntimeServiceWorkProducts(
  products: IssueWorkProduct[],
  liveRuntimeServices: Array<{
    id: string;
    url: string | null;
    status: string;
    healthStatus: string;
  }>,
): IssueWorkProduct[] {
  if (products.length === 0) return products;
  const liveById = new Map(liveRuntimeServices.map((service) => [service.id, service]));
  return products.map((product) => {
    if (product.type !== "runtime_service" || !product.runtimeServiceId) return product;
    const live = liveById.get(product.runtimeServiceId);
    if (!live) {
      return product.healthStatus === "unhealthy" ? product : { ...product, healthStatus: "unhealthy" };
    }
    const isServing = live.status === "running" && live.healthStatus === "healthy";
    const url = live.url ?? product.url;
    const healthStatus: IssueWorkProduct["healthStatus"] = isServing ? "healthy" : "unhealthy";
    if (product.url === url && product.healthStatus === healthStatus) return product;
    return { ...product, url, healthStatus };
  });
}

/**
 * The read path only selects a runtime service when both the id and the
 * company match. Writes use that same predicate and fail closed: a missing
 * id and another company's id are the same rejection, so the response does
 * not reveal that a foreign service exists.
 */
async function assertRuntimeServiceInCompany(
  db: Db,
  companyId: string,
  runtimeServiceId: string | null | undefined,
) {
  if (!runtimeServiceId) return;
  const match = await db
    .select({ id: workspaceRuntimeServices.id })
    .from(workspaceRuntimeServices)
    .where(and(
      eq(workspaceRuntimeServices.id, runtimeServiceId),
      eq(workspaceRuntimeServices.companyId, companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!match) {
    throw unprocessable("Runtime service was not found in this company");
  }
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      const products = rows.map(toIssueWorkProduct);
      const runtimeServiceIds = products
        .map((product) => (product.type === "runtime_service" ? product.runtimeServiceId : null))
        .filter((value): value is string => Boolean(value));
      if (runtimeServiceIds.length === 0) return products;
      // The foreign key is the service id alone. Match the owning company too,
      // or a work product that names another company's service id would copy
      // that service's URL and health into this company's issue.
      const companyIds = [...new Set(products.map((product) => product.companyId))];
      const liveRuntimeServices = await db
        .select({
          id: workspaceRuntimeServices.id,
          url: workspaceRuntimeServices.url,
          status: workspaceRuntimeServices.status,
          healthStatus: workspaceRuntimeServices.healthStatus,
        })
        .from(workspaceRuntimeServices)
        .where(and(
          inArray(workspaceRuntimeServices.id, [...new Set(runtimeServiceIds)]),
          inArray(workspaceRuntimeServices.companyId, companyIds),
        ));
      return reconcileRuntimeServiceWorkProducts(products, liveRuntimeServices);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        await assertRuntimeServiceInCompany(tx as unknown as Db, companyId, data.runtimeServiceId);
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const companyId = typeof patch.companyId === "string" ? patch.companyId : existing.companyId;
        if (Object.prototype.hasOwnProperty.call(patch, "runtimeServiceId")) {
          await assertRuntimeServiceInCompany(tx as unknown as Db, companyId, patch.runtimeServiceId);
        }

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    /**
     * Batched work-product insert for company import.
     *
     * {@link createForIssue} clears the prior primary of the same type on every
     * call; imported issues are brand new, so the only primaries in play are the
     * imported rows themselves. We reproduce "last primary wins" within each
     * (issue, type) group and insert the whole batch in chunked statements.
     */
    createManyForImport: async (rows: ImportIssueWorkProductRow[]): Promise<void> => {
      if (rows.length === 0) return;
      const lastPrimaryIndexByGroup = new Map<string, number>();
      rows.forEach((row, index) => {
        if (row.isPrimary) lastPrimaryIndexByGroup.set(`${row.issueId}:${row.type}`, index);
      });
      const values = rows.map((row, index) => ({
        companyId: row.companyId,
        issueId: row.issueId,
        projectId: row.projectId ?? null,
        type: row.type,
        provider: row.provider,
        externalId: row.externalId ?? null,
        title: row.title,
        url: row.url ?? null,
        status: row.status,
        reviewState: row.reviewState,
        isPrimary: row.isPrimary
          ? lastPrimaryIndexByGroup.get(`${row.issueId}:${row.type}`) === index
          : false,
        healthStatus: row.healthStatus,
        summary: row.summary ?? null,
        metadata: row.metadata ?? null,
        executionWorkspaceId: row.executionWorkspaceId ?? null,
        runtimeServiceId: row.runtimeServiceId ?? null,
        createdByRunId: row.createdByRunId ?? null,
        sourceTrust: row.sourceTrust ?? null,
      }));
      // Chunked writes are wrapped in a single transaction so a large import
      // that spans multiple insert statements is atomic: if a later chunk
      // fails, the earlier chunks roll back rather than leaving a partial
      // prefix behind (which a retry would then duplicate). Mirrors the
      // per-writer transaction the batched issue/document writers use.
      await db.transaction(async (tx) => {
        await insertRowsInChunks(tx, issueWorkProducts, values);
      });
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
