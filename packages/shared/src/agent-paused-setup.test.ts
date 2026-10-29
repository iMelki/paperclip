import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./validators/agent.js";
import { isPausedAgentSetup, pausedAgentSetupFields, pausedAgentSetupProblem } from "./agent-paused-setup.js";

const inert = () => ({ name: "CFO", pausedSetup: true, ...pausedAgentSetupFields() });
describe("paused agent setup boundary", () => {
  it("retains inert state and denies every automatic wake alias", () => {
    const fields = pausedAgentSetupFields({ unrelated: "preserve" });
    expect(fields.adapterType).toBe("process");
    expect(fields.adapterConfig).toEqual({});
    expect(fields.defaultEnvironmentId).toBeNull();
    expect(fields.permissions).toEqual({ canCreateAgents: false, canCreateSkills: false, canAssignTasks: false });
    expect(Object.entries(fields.runtimeConfig.heartbeat).filter(([key]) => key.startsWith("wake")).every(([, value]) => value === false)).toBe(true);
    expect(fields.runtimeConfig.heartbeat.enabled).toBe(false);
    expect(fields.runtimeConfig.heartbeat.intervalSec).toBe(0);
    expect(isPausedAgentSetup(fields.metadata)).toBe(true);
    expect(fields.metadata).toMatchObject({ unrelated: "preserve" });
    expect(pausedAgentSetupProblem(inert())).toBeNull();
  });
  it.each([
    [{ adapterType: "claude_local" }, "unconfigured process"],
    [{ adapterConfig: { command: "must-never-launch" } }, "adapter configuration"],
    [{ adapterConfig: { env: { ANTHROPIC_API_KEY: "SENTINEL_DO_NOT_RESOLVE" } } }, "adapter configuration"],
    [{ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" }, "execution environment"],
    [{ desiredSkills: [{ key: "must-not-install" }] }, "instructions or skills"],
    [{ instructionsBundle: { files: { "AGENTS.md": "must-not-materialize" } } }, "instructions or skills"],
    [{ permissions: { canCreateAgents: true } }, "grant permissions"],
    [{ permissions: { canCreateSkills: true } }, "grant permissions"],
    [{ runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { command: "must-not-launch" } } } } }, "runtime extensions"],
    [{ runtimeConfig: { heartbeat: { enabled: true } } }, "wakes disabled"],
    [{ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }, "wakes disabled"],
    [{ runtimeConfig: { heartbeat: { wakeOnAssignment: true } } }, "wakes disabled"],
    [{ runtimeConfig: { heartbeat: { wakeOnOnDemand: true } } }, "wakes disabled"],
    [{ runtimeConfig: { heartbeat: { wakeOnAutomation: true } } }, "wakes disabled"],
    [{ runtimeConfig: { heartbeat: { intervalSec: 1 } } }, "wakes disabled"],
    [{ budgetMonthlyCents: 1 }, "spending limits"],
  ])("rejects conflicting setup before preparation: %j", (patch, reason) => {
    expect(pausedAgentSetupProblem({ ...inert(), ...patch })).toContain(reason);
    expect(pausedAgentSetupProblem(inert())).toBeNull();
  });
  it("preserves historical parsed requests without adding a false field", () => {
    const ordinary = { name: "ordinary", adapterType: "process" };
    expect(createAgentSchema.parse(ordinary)).not.toHaveProperty("pausedSetup");
    expect(createAgentHireSchema.parse(ordinary)).not.toHaveProperty("pausedSetup");
    expect(createAgentHireSchema.parse(inert()).pausedSetup).toBe(true);
    expect(updateAgentSchema.parse({ pausedSetup: true })).not.toHaveProperty("pausedSetup");
  });
});
