/** Host-only job scope planning. Plugin mappings are never an authority source. */
export interface PluginJobDispatchPlan {
  scope: "instance" | "company";
  companyIds: readonly string[];
  /**
   * Set for jobs declared with `scope: "company"`: a retry without a company reruns every
   * configured company. Strict `dispatchScope: "company"` plans leave it unset and require
   * the original company for a retry.
   */
  lenient?: boolean;
}

export type PluginJobTrigger = "schedule" | "manual" | "retry";

function exactCompanyId(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error("Company job dispatch requires a non-empty, exact company ID");
  }
  return value;
}

export async function resolvePluginJobDispatchPlan(
  declaration: { dispatchScope?: unknown } | undefined,
  readConfiguredCompanies: () => Promise<readonly unknown[]>,
): Promise<PluginJobDispatchPlan> {
  if (!declaration) throw new Error("Job is no longer declared by the installed plugin");
  const scope = declaration.dispatchScope;
  if (scope === undefined || scope === "instance") return { scope: "instance", companyIds: [] };
  if (scope !== "company") throw new Error("Unsupported plugin job dispatch scope");
  const companyIds = [...new Set((await readConfiguredCompanies()).map(exactCompanyId))].sort();
  if (companyIds.length === 0) throw new Error("Company job has no host-configured companies; nothing dispatched");
  return { scope, companyIds };
}

export function selectPluginJobCompanies(
  plan: PluginJobDispatchPlan,
  trigger: PluginJobTrigger,
  requestedCompanyId?: string,
): Array<string | null> {
  if (plan.scope === "instance") {
    if (requestedCompanyId !== undefined) throw new Error("Job is instance-scoped and cannot be triggered for one company");
    return [null];
  }
  if (plan.scope !== "company" || plan.companyIds.length === 0) {
    throw new Error("Company job dispatch plan is missing its authorized companies");
  }
  const companies = [...new Set(plan.companyIds.map(exactCompanyId))].sort();
  if (trigger === "retry" && requestedCompanyId === undefined && !plan.lenient) {
    throw new Error("Retry a company job with its original company ID; instance-wide replay is refused");
  }
  if (requestedCompanyId === undefined) return companies;
  const companyId = exactCompanyId(requestedCompanyId);
  if (!companies.includes(companyId)) throw new Error(`Company "${companyId}" has not configured plugin for this job`);
  return [companyId];
}

export function createPluginJobEnvelope(
  jobKey: string,
  runId: string,
  trigger: PluginJobTrigger,
  scheduledAt: string,
  companyId: string | null,
) {
  const scope = companyId === null ? {} : { companyId: exactCompanyId(companyId) };
  return { ...scope, job: { jobKey, runId, trigger, scheduledAt, ...scope } };
}
