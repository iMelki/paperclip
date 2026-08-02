import { describe, expect, it } from "vitest";
import {
  hostNodes,
  agentInstances,
  taskParticipations,
  mutationLeases,
  controlIntents,
} from "./schema/index.js";

describe("Task Coordination Schema Foundation", () => {
  it("exports all task coordination tables from schema index", () => {
    expect(hostNodes).toBeDefined();
    expect(agentInstances).toBeDefined();
    expect(taskParticipations).toBeDefined();
    expect(mutationLeases).toBeDefined();
    expect(controlIntents).toBeDefined();
  });

  it("defines correct table names", () => {
    expect(hostNodes._.name).toBe("host_nodes");
    expect(agentInstances._.name).toBe("agent_instances");
    expect(taskParticipations._.name).toBe("task_participations");
    expect(mutationLeases._.name).toBe("mutation_leases");
    expect(controlIntents._.name).toBe("control_intents");
  });
});
