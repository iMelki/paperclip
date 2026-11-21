import { and, eq } from "drizzle-orm";
import { toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, notFound, unprocessable } from "../errors.js";
import { toolConnectionSnapshotColumns } from "./tool-connection-snapshot.js";

const targetSchema = z.object({ connectionId: z.string().uuid(), companyId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional() }).strict();
type MutationTarget = z.infer<typeof targetSchema>;

/** Call only with the caller's transaction executor. Application UPDATE always precedes connection UPDATE. */
export async function lockToolConnectionMutation(executor: Db, value: MutationTarget) {
  const parsed = targetSchema.safeParse(value);
  if (!parsed.success) throw unprocessable("Invalid exact tool connection mutation target");
  const input = parsed.data;
  const [candidate] = await executor.select({ id: toolConnections.id, companyId: toolConnections.companyId,
    applicationId: toolConnections.applicationId }).from(toolConnections).where(and(
    eq(toolConnections.id, input.connectionId), input.companyId ? eq(toolConnections.companyId, input.companyId) : undefined,
  )).limit(1);
  if (!candidate) throw notFound("Tool connection not found");
  if (input.applicationId && candidate.applicationId !== input.applicationId) {
    throw conflict("Tool connection application changed before mutation");
  }
  const [application] = await executor.select({ id: toolApplications.id }).from(toolApplications).where(and(
    eq(toolApplications.id, candidate.applicationId), eq(toolApplications.companyId, candidate.companyId),
  )).for("update").limit(1);
  if (!application) throw conflict("Matching tool connection application required before mutation");
  const [connection] = await executor.select(toolConnectionSnapshotColumns).from(toolConnections).where(and(
    eq(toolConnections.id, candidate.id), eq(toolConnections.companyId, candidate.companyId),
    eq(toolConnections.applicationId, candidate.applicationId),
  )).for("update").limit(1);
  if (!connection) throw conflict("Tool connection scope changed while acquiring mutation ownership");
  return connection;
}
