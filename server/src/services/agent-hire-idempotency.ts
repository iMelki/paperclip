import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentHireRequests, type Db } from "@paperclipai/db";
import { badRequest, conflict } from "../errors.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";

type HireResult = {
  agent: NonNullable<Awaited<ReturnType<ReturnType<typeof agentService>["getById"]>>>;
  approval: Awaited<ReturnType<ReturnType<typeof approvalService>["getById"]>> | null;
};

export function readHireIdempotencyKey(header: string | undefined, body: string | undefined) {
  const key = header?.trim();
  if (header !== undefined && (!key || key.length > 255 || !/^[\x21-\x7e]+$/.test(key))) {
    throw badRequest("Idempotency-Key must contain 1 to 255 visible ASCII characters");
  }
  if (key !== undefined && body !== undefined && key !== body) {
    throw badRequest("Idempotency-Key header and idempotencyKey body field must match");
  }
  return key ?? body;
}

// Sort object keys recursively; preserve array order and JSON value types.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprintHireRequest(payload: Record<string, unknown>, sourceIssueIds: string[]) {
  const { idempotencyKey: _key, sourceIssueId: _issue, sourceIssueIds: _issues, ...input } = payload;
  // Zod has already applied request defaults. Exclude generated agent IDs, key isolation,
  // secret references, and adapter defaults that can change between retries.
  return createHash("sha256").update(canonicalJson({ ...input, sourceIssueIds: [...sourceIssueIds].sort() })).digest("hex");
}

async function replayHire(db: Db, companyId: string, existing: typeof agentHireRequests.$inferSelect, fingerprint: string) {
  if (existing.requestFingerprint !== fingerprint) {
    throw conflict("Idempotency key is already used with a different hire payload");
  }
  const agent = existing.agentId ? await agentService(db).getById(existing.agentId) : null;
  const approval = existing.approvalId ? await approvalService(db).getById(existing.approvalId) : null;
  if (!agent || agent.companyId !== companyId || (existing.approvalId && !approval)
    || (approval && approval.companyId !== companyId)) {
    throw conflict("The original idempotent hire is unavailable; do not retry with a new key");
  }
  return { result: { agent, approval }, replayed: true };
}

export async function executeAgentHire<Prepared>(
  db: Db,
  companyId: string,
  key: string | undefined,
  fingerprint: string,
  prepare: () => Promise<Prepared>,
  create: (source: Db, prepared: Prepared) => Promise<HireResult>,
): Promise<{ result: HireResult; replayed: boolean }> {
  if (key === undefined) return { result: await create(db, await prepare()), replayed: false };
  const scope = and(eq(agentHireRequests.companyId, companyId), eq(agentHireRequests.idempotencyKey, key));
  // Optimization only: completed retries skip filesystem/inventory preparation.
  // Absence does NOT authorize creation; the transaction's unique insert does.
  const [completed] = await db.select().from(agentHireRequests).where(scope);
  if (completed) return replayHire(db, companyId, completed, fingerprint);
  // Skill inventory refresh uses a shared promise and must finish outside a
  // transaction, including when the database pool has only one connection.
  const prepared = await prepare();
  return db.transaction(async (tx) => {
    const source = tx as unknown as Db;
    await tx.execute(sql`set local lock_timeout = '30s'`);
    const [claimed] = await tx.insert(agentHireRequests).values({
      companyId, idempotencyKey: key, requestFingerprint: fingerprint,
    }).onConflictDoNothing({ target: [agentHireRequests.companyId, agentHireRequests.idempotencyKey] }).returning();
    if (!claimed) {
      // Fresh READ COMMITTED snapshot after the unique-index wait.
      const [existing] = await tx.select().from(agentHireRequests).where(scope);
      if (!existing) throw conflict("Hire is still in progress; retry with the same idempotency key and payload");
      return replayHire(source, companyId, existing, fingerprint);
    }
    const result = await create(source, prepared);
    await tx.update(agentHireRequests).set({ agentId: result.agent.id, approvalId: result.approval?.id ?? null }).where(scope);
    return { result, replayed: false };
  }, { isolationLevel: "read committed" }).catch((error: unknown) => {
    const pgError = error as { code?: string; cause?: { code?: string } };
    if (pgError.code === "55P03" || pgError.cause?.code === "55P03") {
      throw conflict("Hire is still in progress; retry with the same idempotency key and payload");
    }
    throw error;
  });
}
