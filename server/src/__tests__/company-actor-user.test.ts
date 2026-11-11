import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { agentApiKeys, agents, authUsers, companies, companyMemberships } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { afterEach, expect, it } from "vitest";
import {
  resolveEligibleCompanyActorUserId,
  userHasActiveCompanyAccess,
} from "../services/company-actor-user.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("company actor user", () => {
  const ctx = useEmbeddedPostgres("company-actor-user");

  afterEach(async () => {
    await ctx.db.delete(agentApiKeys);
    await ctx.db.delete(agents);
    await resetCompanyIssueFixtures(ctx.db);
    await ctx.db.delete(authUsers);
  });

  async function insertUser(id: string) {
    const now = new Date();
    await ctx.db.insert(authUsers).values({
      id,
      name: "Company member",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("uses a configured member and rejects a user without company access", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Actor company");
    const outsider = `user-${randomUUID()}`;
    await insertUser(seeded.userId);
    await insertUser(outsider);

    expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, outsider)).toBe(false);
    expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, seeded.userId)).toBe(true);

    await expect(resolveEligibleCompanyActorUserId(ctx.db, seeded.companyId, {
      configuredUserId: outsider,
    })).resolves.toBe(seeded.userId);
    await expect(resolveEligibleCompanyActorUserId(ctx.db, seeded.companyId, {
      configuredUserId: seeded.userId,
    })).resolves.toBe(seeded.userId);
  });

  it("does not run when no configured member and no owner can be resolved", async () => {
    const companyId = randomUUID();
    await ctx.db.insert(companies).values({
      id: companyId,
      name: `Empty ${companyId}`,
      issuePrefix: `E${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const outsider = `user-${randomUUID()}`;

    await expect(resolveEligibleCompanyActorUserId(ctx.db, companyId, {
      configuredUserId: outsider,
    })).resolves.toBeNull();
    expect(await ctx.db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(authUsers)).toHaveLength(0);
  });

  it("does not invent a user row when the owner membership has no user", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Membership only");

    await expect(resolveEligibleCompanyActorUserId(ctx.db, seeded.companyId, {
      configuredUserId: "",
    })).resolves.toBeNull();
    expect(await ctx.db.select().from(authUsers)).toHaveLength(0);
  });
  it("skips an owner membership with no user row and picks the next eligible owner", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Orphan owner first");
    // The seeded owner is the oldest membership and has no user row.
    const laterOwner = `user-${randomUUID()}`;
    await insertUser(laterOwner);
    await ctx.db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: laterOwner,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(Date.now() + 1_000),
      createdAt: new Date(Date.now() + 1_000),
    });

    await expect(resolveEligibleCompanyActorUserId(ctx.db, seeded.companyId, {
      configuredUserId: "",
    })).resolves.toBe(laterOwner);
  });

  it("does not use a read-only viewer as the actor", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Viewer configured");
    await insertUser(seeded.userId);
    const viewer = `user-${randomUUID()}`;
    await insertUser(viewer);
    await ctx.db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: viewer,
      status: "active",
      membershipRole: "viewer",
      updatedAt: new Date(),
    });

    expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, viewer)).toBe(false);
    await expect(resolveEligibleCompanyActorUserId(ctx.db, seeded.companyId, {
      configuredUserId: viewer,
    })).resolves.toBe(seeded.userId);
  });
  it("rejects a revoked real responsible user with 403 in enforce mode without substituting the company owner", async () => {
    const previousMode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
    const previousShadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
    const previousActor = process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID;
    try {
      process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE = "enforce";
      process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = "false";
      const seeded = await seedCompanyWithBoardAccess(ctx.db, "Revoked responsible user");
      await insertUser(seeded.userId);
      const ordinaryUserId = `user-${randomUUID()}`;
      await insertUser(ordinaryUserId);
      await ctx.db.insert(companyMemberships).values({
        companyId: seeded.companyId, principalType: "user", principalId: ordinaryUserId,
        status: "active", membershipRole: "member",
      });
      const [agent] = await ctx.db.insert(agents).values({
        companyId: seeded.companyId, name: "Revocation regression agent", status: "idle",
      }).returning();
      const token = `pcp_test_${randomUUID()}`;
      await ctx.db.insert(agentApiKeys).values({
        agentId: agent!.id, companyId: seeded.companyId, name: "Revocation regression key",
        keyHash: createHash("sha256").update(token).digest("hex"),
        responsibleUserId: ordinaryUserId,
      });
      // An eligible configured owner exists throughout; an ordinary user must never be replaced.
      process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID = seeded.userId;
      const seenActors: Express.Request["actor"][] = [];
      const app = express();
      app.use(actorMiddleware(ctx.db, { deploymentMode: "authenticated", resolveSession: async () => null }));
      app.use((req, _res, next) => { seenActors.push(req.actor); next(); });
      app.get("/companies/:companyId/protected", (req, res) => {
        assertCompanyAccess(req, req.params.companyId);
        res.json({ onBehalfOfUserId: req.actor.onBehalfOfUserId });
      });
      app.use(errorHandler);
      const allowed = await request(app).get(`/companies/${seeded.companyId}/protected`)
        .set("Authorization", `Bearer ${token}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.onBehalfOfUserId).toBe(ordinaryUserId);
      await ctx.db.delete(companyMemberships).where(and(
        eq(companyMemberships.companyId, seeded.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, ordinaryUserId),
      ));
      const denied = await request(app).get(`/companies/${seeded.companyId}/protected`)
        .set("Authorization", `Bearer ${token}`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
      expect(seenActors.at(-1)?.onBehalfOfUserId).toBe(ordinaryUserId);
      expect(seenActors.at(-1)?.onBehalfOfMemberships).toEqual([]);
      expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, seeded.userId)).toBe(true);
      expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, ordinaryUserId)).toBe(false);
      const [persisted] = await ctx.db.select().from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, agent!.id));
      expect(persisted?.responsibleUserId).toBe(ordinaryUserId);
    } finally {
      if (previousMode === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
      else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE = previousMode;
      if (previousShadow === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
      else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = previousShadow;
      if (previousActor === undefined) delete process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID;
      else process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID = previousActor;
    }
  });

});
