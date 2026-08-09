import { getTableName } from "drizzle-orm";
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
    // drizzle-orm 0.45 moved table metadata off the `._` property onto
    // Symbol keys (Symbol(drizzle:Name) etc.) -- `._` is a private,
    // unstable internal that changed shape between minor versions.
    // getTableName() is the public, stable accessor.
    expect(getTableName(hostNodes)).toBe("host_nodes");
    expect(getTableName(agentInstances)).toBe("agent_instances");
    expect(getTableName(taskParticipations)).toBe("task_participations");
    expect(getTableName(mutationLeases)).toBe("mutation_leases");
    expect(getTableName(controlIntents)).toBe("control_intents");
  });
});
