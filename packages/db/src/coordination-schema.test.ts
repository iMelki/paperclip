import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  hostNodes,
  agentInstances,
  taskParticipations,
  mutationLeases,
  coordinationClaimIdempotencyKeys,
  controlIntents,
} from "./schema/index.js";

describe("Task Coordination Schema Foundation", () => {
  it("exports all task coordination tables from schema index", () => {
    expect(hostNodes).toBeDefined();
    expect(agentInstances).toBeDefined();
    expect(taskParticipations).toBeDefined();
    expect(mutationLeases).toBeDefined();
    expect(coordinationClaimIdempotencyKeys).toBeDefined();
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
    expect(getTableName(coordinationClaimIdempotencyKeys)).toBe("coordination_claim_idempotency_keys");
    expect(getTableName(controlIntents)).toBe("control_intents");
  });

  it("stores only a lease-token hash and persists claim idempotency state", () => {
    expect(mutationLeases).toHaveProperty("leaseTokenHash");
    expect(mutationLeases).not.toHaveProperty("leaseToken");
    expect(coordinationClaimIdempotencyKeys).toHaveProperty("requestHash");
    expect(coordinationClaimIdempotencyKeys).toHaveProperty("mutationLeaseId");
    expect(coordinationClaimIdempotencyKeys).toHaveProperty("responseBody");
    expect(coordinationClaimIdempotencyKeys).toHaveProperty("expiresAt");
  });
});
