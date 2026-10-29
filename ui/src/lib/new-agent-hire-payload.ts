import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config.js";
import type { AgentPermissions } from "@paperclipai/shared";

export function buildNewAgentHirePayload(input: {
  name: string;
  pausedSetup?: boolean;
  idempotencyKey?: string;
  effectiveRole: string;
  title?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  permissions?: Partial<AgentPermissions>;
}) {
  const {
    name,
    effectiveRole,
    title,
    reportsTo,
    selectedSkillKeys = [],
    configValues,
    adapterConfig,
    permissions,
    pausedSetup,
    idempotencyKey,
  } = input;

  if (pausedSetup) {
    return {
      name: name.trim(), role: effectiveRole, ...(title?.trim() ? { title: title.trim() } : {}),
      ...(reportsTo ? { reportsTo } : {}), ...(idempotencyKey ? { idempotencyKey } : {}),
      pausedSetup: true, adapterType: "process", adapterConfig: {}, defaultEnvironmentId: null,
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false, wakeOnAssignment: false, wakeOnOnDemand: false, wakeOnAutomation: false, maxConcurrentRuns: 1 } },
      permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false }, budgetMonthlyCents: 0,
    };
  }
  return {
    ...(idempotencyKey ? { idempotencyKey } : {}),
    name: name.trim(),
    role: effectiveRole,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
      cheapModel: configValues.cheapModel,
      cheapModelEnabled: configValues.cheapModelEnabled,
    }),
    budgetMonthlyCents: 0,
    ...(permissions ? { permissions } : {}),
  };
}
