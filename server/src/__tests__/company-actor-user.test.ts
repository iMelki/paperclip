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
});
