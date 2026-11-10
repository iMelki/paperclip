import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { authUsers, companies, companyMemberships } from "@paperclipai/db";
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
});
