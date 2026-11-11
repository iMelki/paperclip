import { and, eq, like, sql } from "drizzle-orm";
import { plugins, pluginJobs, pluginState, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, conflict } from "../errors.js";
import { GITHUB_PROJECT_BINDING_NAMESPACE, GITHUB_PROJECT_IMPORTER_KEY } from "./plugin-github-project-board.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY, scheduleGrantSchema } from "./github-project-schedule-grant-contract.js";

export const NATIVE_BOARD_MAX_PROJECTS = 20;
export const NATIVE_BOARD_MAX_GRANT_ROWS = 1000;
export const isNativeGitHubBoardJobKey = (jobKey: string) => jobKey === GITHUB_PROJECT_BOARD_JOB_KEY;
export interface NativeBoardJobTarget { companyId: string; projectId: string; jobId: string }
type GrantRow = Pick<typeof pluginState.$inferSelect, "scopeId" | "stateKey" | "valueJson">;

/** Native grant metadata is the only target source. Plugin configs/mappings are never consulted. */
export function selectNativeBoardJobTargets(rows: readonly GrantRow[], pluginId: string, jobId: string,
  companyId?: string, now = Date.now()): NativeBoardJobTarget[] {
  if (rows.length > NATIVE_BOARD_MAX_GRANT_ROWS) throw conflict("Native board grant scan exceeds its bounded limit");
  const selected = new Map<string, NativeBoardJobTarget>();
  for (const row of rows) {
    const parsed = scheduleGrantSchema.safeParse(row.valueJson);
    if (!parsed.success || parsed.data.pluginId !== pluginId || row.scopeId !== parsed.data.companyId
      || row.stateKey !== `schedule-grant:${parsed.data.projectId}`) throw conflict("Native board grant metadata scope is invalid");
    const grant = parsed.data;
    if (grant.jobId !== jobId || !grant.enabled || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= now) continue;
    if (companyId !== undefined && grant.companyId !== companyId) continue;
    selected.set(`${grant.companyId}:${grant.projectId}`, { companyId: grant.companyId, projectId: grant.projectId, jobId });
  }
  if (selected.size > NATIVE_BOARD_MAX_PROJECTS) throw conflict("Native board job exceeds its bounded project limit");
  return [...selected.values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.projectId.localeCompare(b.projectId));
}

export interface NativeBoardExcludedCompany { companyId: string; reason: string }
const STATIC_EXCLUSION_REASON = "Native board grant metadata for this company is invalid or exceeds its bounded limits";

/**
 * Reads the current native board targets. With `companyId` the result is that company's only (and a bad row
 * for it throws, so its own run is refused). Without it every company with grant rows is read separately:
 * a company whose rows are invalid or over a cap is excluded with a static reason and never stops the others.
 */
export async function readNativeBoardJobTargets(db: Db, pluginId: string, jobId?: string, companyId?: string) {
  if (!z.string().uuid().safeParse(pluginId).success || jobId !== undefined && !z.string().uuid().safeParse(jobId).success
    || companyId !== undefined && !z.string().uuid().safeParse(companyId).success) throw forbidden("Exact native board scope required");
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '10000ms'`);
    await tx.execute(sql`set local lock_timeout = '5000ms'`);
    const [plugin] = await tx.select().from(plugins).where(eq(plugins.id, pluginId)).for("share").limit(1);
    const [job] = await tx.select().from(pluginJobs).where(and(eq(pluginJobs.pluginId, pluginId),
      eq(pluginJobs.jobKey, GITHUB_PROJECT_BOARD_JOB_KEY))).for("share").limit(1);
    if (!plugin || plugin.pluginKey !== GITHUB_PROJECT_IMPORTER_KEY || plugin.status !== "ready"
      || !job || job.status !== "active" || jobId !== undefined && job.id !== jobId) {
      throw forbidden("Ready native GitHub plugin and exact active board job required");
    }
    const grantRows = (scopeId: string) => tx.select({ scopeId: pluginState.scopeId, stateKey: pluginState.stateKey, valueJson: pluginState.valueJson })
      .from(pluginState).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeKind, "company"),
        eq(pluginState.namespace, GITHUB_PROJECT_BINDING_NAMESPACE), like(pluginState.stateKey, "schedule-grant:%"),
        eq(pluginState.scopeId, scopeId))).limit(NATIVE_BOARD_MAX_GRANT_ROWS + 1);
    if (companyId !== undefined) {
      return { job, targets: selectNativeBoardJobTargets(await grantRows(companyId), pluginId, job.id, companyId),
        excluded: [] as NativeBoardExcludedCompany[] };
    }
    const companies = await tx.selectDistinct({ scopeId: pluginState.scopeId }).from(pluginState).where(and(
      eq(pluginState.pluginId, pluginId), eq(pluginState.scopeKind, "company"),
      eq(pluginState.namespace, GITHUB_PROJECT_BINDING_NAMESPACE), like(pluginState.stateKey, "schedule-grant:%")));
    const targets: NativeBoardJobTarget[] = [], excluded: NativeBoardExcludedCompany[] = [];
    for (const { scopeId } of companies) {
      if (!scopeId) continue;
      try { targets.push(...selectNativeBoardJobTargets(await grantRows(scopeId), pluginId, job.id, scopeId)); }
      catch { excluded.push({ companyId: scopeId, reason: STATIC_EXCLUSION_REASON }); }
    }
    return { job, targets, excluded };
  });
}
