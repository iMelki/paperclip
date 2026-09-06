import { getTableName } from "drizzle-orm";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hostNodes,
  agentInstances,
  taskParticipations,
  mutationLeases,
  controlIntents,
  issues,
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

  it("persists a strictly positive coordination generation", () => {
    expect(issues.coordinationGeneration).toBeDefined();
    const migration = fs.readFileSync(
      new URL("./migrations/0213_coordination_generation.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('"coordination_generation" integer DEFAULT 1 NOT NULL');
    expect(migration).toContain("issues_coordination_generation_positive_ck");
    expect(migration).toContain('CHECK ("coordination_generation" > 0)');
  });
});
