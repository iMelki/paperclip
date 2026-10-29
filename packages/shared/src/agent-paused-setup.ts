/** Inert setup shared by board creation, approval and saved-state checks. */
export const PAUSED_AGENT_SETUP_KEY = "paperclip.pausedSetup";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function isPausedAgentSetup(metadata: unknown): boolean {
  return record(metadata)[PAUSED_AGENT_SETUP_KEY] === true;
}

export function pausedAgentSetupFields(metadata?: unknown) {
  return {
    adapterType: "process" as const,
    adapterConfig: {},
    runtimeConfig: { heartbeat: {
      enabled: false, intervalSec: 0, wakeOnDemand: false,
      wakeOnAssignment: false, wakeOnOnDemand: false, wakeOnAutomation: false,
      maxConcurrentRuns: 1,
    } },
    defaultEnvironmentId: null,
    permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false },
    metadata: { ...record(metadata), [PAUSED_AGENT_SETUP_KEY]: true },
  };
}

/** Reject executable configuration before any skill, secret or adapter preparation. */
export function pausedAgentSetupProblem(input: Record<string, unknown>): string | null {
  if (input.adapterType !== "process") return "Paused setup requires the unconfigured process adapter";
  if (Object.keys(record(input.adapterConfig)).length) return "Paused setup cannot include adapter configuration";
  if (input.defaultEnvironmentId != null) return "Paused setup cannot select an execution environment";
  if (input.instructionsBundle != null || (Array.isArray(input.desiredSkills) && input.desiredSkills.length)) {
    return "Paused setup cannot provision instructions or skills";
  }
  if (Number(input.budgetMonthlyCents ?? 0) !== 0) return "Paused setup cannot change spending limits";
  const permissions = record(input.permissions);
  if (Object.values(permissions).some(value => value !== false)) return "Paused setup cannot grant permissions";
  const runtime = record(input.runtimeConfig);
  if (Object.keys(runtime).some(key => key !== "heartbeat")) return "Paused setup cannot configure model profiles or runtime extensions";
  const heartbeat = record(runtime.heartbeat);
  const fields = pausedAgentSetupFields().runtimeConfig.heartbeat;
  for (const [key, value] of Object.entries(heartbeat)) {
    if (!(key in fields) || value !== fields[key as keyof typeof fields]) return "Paused setup requires all automatic wakes disabled";
  }
  return null;
}
