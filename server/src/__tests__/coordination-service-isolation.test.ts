import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  agentInstances,
  companies,
  companyMemberships,
  controlIntents,
  hostNodes,
  issues,
  mutationLeases,
  principalPermissionGrants,
  taskParticipations,
} from "@paperclipai/db";
import { expect, it } from "vitest";
import { coordinationRoutes } from "../routes/coordination.js";
import { getIssueCoordination } from "../services/coordination.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("coordination service company isolation", () => {
  const ctx = useEmbeddedPostgres("paperclip-coordination-isolation-");

  async function clearFixtures() {
    await ctx.db.delete(controlIntents);
    await ctx.db.delete(mutationLeases);
    await ctx.db.delete(taskParticipations);
    await ctx.db.delete(agentInstances);
    await ctx.db.delete(hostNodes);
    await ctx.db.delete(issues);
    await ctx.db.delete(principalPermissionGrants);
    await ctx.db.delete(companyMemberships);
    await ctx.db.delete(companies);
  }

  async function seed() {
    await clearFixtures();
    const companyA = await seedCompanyWithBoardAccess(ctx.db, "Coordination A");
    const companyB = await seedCompanyWithBoardAccess(ctx.db, "Coordination B");
    const rootId = randomUUID();
    const childAId = randomUUID();
    const childForeignLeaseId = randomUUID();
    const childBId = randomUUID();
    const hostAId = randomUUID();
    const hostCrossInstanceId = randomUUID();
    const hostBId = randomUUID();
    const instanceAId = randomUUID();
    const instanceBId = randomUUID();
    const instanceAWithForeignHostId = randomUUID();
    const participationAId = randomUUID();
    const participationBId = randomUUID();
    const participationAWithForeignInstanceId = randomUUID();
    const participationAWithForeignHostId = randomUUID();

    await ctx.db.insert(issues).values([
      { id: rootId, companyId: companyA.companyId, title: "Root A", status: "in_progress", priority: "medium" },
      {
        id: childAId,
        companyId: companyA.companyId,
        parentId: rootId,
        title: "Child A",
        status: "todo",
        priority: "medium",
      },
      {
        id: childForeignLeaseId,
        companyId: companyA.companyId,
        parentId: rootId,
        title: "Child foreign lease",
        status: "todo",
        priority: "medium",
      },
      // The database has independent foreign keys for issue and company. This
      // intentionally malformed row proves every downstream read retains its
      // company predicate even if an inconsistent record exists.
      {
        id: childBId,
        companyId: companyB.companyId,
        parentId: rootId,
        title: "Child B",
        status: "todo",
        priority: "medium",
      },
    ]);
    await ctx.db.insert(hostNodes).values([
      {
        id: hostAId,
        companyId: companyA.companyId,
        hostId: "host-a",
        hostname: "host-a",
        os: "linux",
        runtime: "codex",
      },
      {
        id: hostCrossInstanceId,
        companyId: companyA.companyId,
        hostId: "host-cross-instance",
        hostname: "host-cross-instance",
        os: "linux",
        runtime: "codex",
      },
      {
        id: hostBId,
        companyId: companyB.companyId,
        hostId: "host-b",
        hostname: "host-b",
        os: "linux",
        runtime: "codex",
      },
    ]);
    await ctx.db.insert(agentInstances).values([
      { id: instanceAId, companyId: companyA.companyId, agentId: "agent-a", runtime: "codex", hostNodeId: hostAId },
      // These crossed rows make the instance and host predicates observable
      // independently instead of relying on participation filtering first.
      {
        id: instanceBId,
        companyId: companyB.companyId,
        agentId: "agent-b",
        runtime: "codex",
        hostNodeId: hostCrossInstanceId,
      },
      {
        id: instanceAWithForeignHostId,
        companyId: companyA.companyId,
        agentId: "agent-a-foreign-host",
        runtime: "codex",
        hostNodeId: hostBId,
      },
    ]);
    await ctx.db.insert(taskParticipations).values([
      {
        id: participationAId,
        companyId: companyA.companyId,
        issueId: rootId,
        agentInstanceId: instanceAId,
        runtime: "codex",
      },
      {
        id: participationBId,
        companyId: companyB.companyId,
        issueId: rootId,
        agentInstanceId: instanceBId,
        runtime: "codex",
      },
      {
        id: participationAWithForeignInstanceId,
        companyId: companyA.companyId,
        issueId: rootId,
        agentInstanceId: instanceBId,
        runtime: "codex",
      },
      {
        id: participationAWithForeignHostId,
        companyId: companyA.companyId,
        issueId: rootId,
        agentInstanceId: instanceAWithForeignHostId,
        runtime: "codex",
      },
    ]);
    const expiresAt = new Date(Date.now() + 60_000);
    await ctx.db.insert(mutationLeases).values([
      {
        companyId: companyA.companyId,
        issueId: childAId,
        taskParticipationId: participationAId,
        leaseToken: "lease-a",
        holderAgentId: "agent-a",
        workUnitId: "unit-a",
        scopeRepositories: ["repo-a"],
        scopePaths: ["src/a"],
        expiresAt,
      },
      {
        companyId: companyB.companyId,
        issueId: childForeignLeaseId,
        taskParticipationId: participationBId,
        leaseToken: "lease-b",
        holderAgentId: "agent-b",
        workUnitId: "unit-b",
        scopeRepositories: ["repo-b"],
        scopePaths: ["src/b"],
        expiresAt,
      },
    ]);
    await ctx.db.insert(controlIntents).values([
      { companyId: companyA.companyId, rootIssueId: rootId, intentType: "pause", requestedBy: "user-a" },
      { companyId: companyB.companyId, rootIssueId: rootId, intentType: "cancel", requestedBy: "user-b" },
    ]);

    return {
      companyA,
      companyB,
      rootId,
      childAId,
      childForeignLeaseId,
      childBId,
      participationAId,
      participationAWithForeignInstanceId,
      participationAWithForeignHostId,
      participationBId,
    };
  }

  it("returns only rows belonging to the authorized root company", async () => {
    const seeded = await seed();

    const view = await getIssueCoordination(ctx.db, seeded.rootId, seeded.companyA.companyId);

    expect(view).not.toBeNull();
    expect(view!.workUnits.map((unit) => unit.id).sort()).toEqual([
      seeded.childAId,
      seeded.childForeignLeaseId,
    ].sort());
    expect(view!.workUnits.find((unit) => unit.id === seeded.childAId)!.mutationScope).toEqual({
      repositories: ["repo-a"],
      paths: ["src/a"],
    });
    expect(view!.workUnits.find((unit) => unit.id === seeded.childForeignLeaseId)!.mutationScope).toEqual({
      repositories: [],
      paths: [],
    });
    expect(view!.participants.map((participant) => participant.id).sort()).toEqual([
      seeded.participationAId,
      seeded.participationAWithForeignInstanceId,
      seeded.participationAWithForeignHostId,
    ].sort());
    expect(view!.placements.map((placement) => placement.hostId)).toEqual(["host-a"]);
    expect(view!.controls.pendingIntents).toEqual([
      expect.objectContaining({ intentType: "pause", requestedBy: "user-a" }),
    ]);
  });

  it("does not resolve a root from another company", async () => {
    const seeded = await seed();

    await expect(getIssueCoordination(ctx.db, seeded.rootId, seeded.companyB.companyId)).resolves.toBeNull();
    const foreignChildren = await ctx.db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, seeded.rootId), eq(issues.companyId, seeded.companyB.companyId)));
    expect(foreignChildren).toEqual([{ id: seeded.childBId }]);
  });

  it("enforces company isolation through the real HTTP route and service boundary", async () => {
    const seeded = await seed();

    const authorized = await request(routeApp(ctx.db, seeded.companyA.actor, coordinationRoutes))
      .get(`/api/issues/${seeded.rootId}/coordination`);
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    expect(authorized.body.workUnits.map((unit: { id: string }) => unit.id).sort()).toEqual([
      seeded.childAId,
      seeded.childForeignLeaseId,
    ].sort());
    expect(
      authorized.body.workUnits.find((unit: { id: string }) => unit.id === seeded.childAId).mutationScope,
    ).toEqual({ repositories: ["repo-a"], paths: ["src/a"] });
    expect(
      authorized.body.workUnits.find((unit: { id: string }) => unit.id === seeded.childForeignLeaseId).mutationScope,
    ).toEqual({ repositories: [], paths: [] });
    expect(authorized.body.participants.map((participant: { id: string }) => participant.id).sort()).toEqual([
      seeded.participationAId,
      seeded.participationAWithForeignInstanceId,
      seeded.participationAWithForeignHostId,
    ].sort());
    expect(authorized.body.placements.map((placement: { hostId: string }) => placement.hostId)).toEqual([
      "host-a",
    ]);
    expect(authorized.body.controls.pendingIntents).toEqual([
      expect.objectContaining({ intentType: "pause", requestedBy: "user-a" }),
    ]);

    const foreign = await request(routeApp(ctx.db, seeded.companyB.actor, coordinationRoutes))
      .get(`/api/issues/${seeded.rootId}/coordination`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: "Root issue not found" });
  });
});
