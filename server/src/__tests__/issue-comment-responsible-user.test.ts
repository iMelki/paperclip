import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, authUsers, issueComments, issues } from "@paperclipai/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BUILT_IN_BUNDLE_ACTOR_USER_ID, userHasActiveCompanyAccess } from "../services/company-actor-user.js";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue comment responsible user", () => {
  const ctx = useEmbeddedPostgres("issue-comment-responsible-user");
  let previousActorUserId: string | undefined;

  beforeEach(() => {
    previousActorUserId = process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID;
    delete process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID;
  });

  afterEach(async () => {
    if (previousActorUserId === undefined) delete process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID;
    else process.env.PAPERCLIP_BUILT_IN_ACTOR_USER_ID = previousActorUserId;
    await ctx.db.delete(issues);
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

  async function seedIssue() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Comment company");
    await insertUser(seeded.userId);
    const agentId = randomUUID();
    const issueId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      title: "Daily summary",
      status: "todo",
      priority: "medium",
    });
    return { ...seeded, agentId, issueId };
  }

  it("writes a comment as the resolved real user and satisfies the user foreign key", async () => {
    const seeded = await seedIssue();
    const comment = await issueService(ctx.db).addComment(seeded.issueId, "Summary for the board", {
      agentId: seeded.agentId,
      onBehalfOfUserId: BUILT_IN_BUNDLE_ACTOR_USER_ID,
    });

    expect(comment.onBehalfOfUserId).toBe(seeded.userId);
    const joined = await ctx.db
      .select({ userId: authUsers.id })
      .from(issueComments)
      .innerJoin(authUsers, eq(issueComments.onBehalfOfUserId, authUsers.id))
      .where(eq(issueComments.id, comment.id));
    expect(joined).toEqual([{ userId: seeded.userId }]);
    expect(await ctx.db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, BUILT_IN_BUNDLE_ACTOR_USER_ID))).toHaveLength(0);
  });

  it("rejects a missing user and does not insert a comment or a user", async () => {
    const seeded = await seedIssue();
    const missingUserId = `missing-${randomUUID()}`;
    const usersBefore = await ctx.db.select({ id: authUsers.id }).from(authUsers);

    await expect(issueService(ctx.db).addComment(seeded.issueId, "This comment must not be saved", {
      agentId: seeded.agentId,
      onBehalfOfUserId: missingUserId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    expect(await ctx.db.select({ id: issueComments.id }).from(issueComments)).toHaveLength(0);
    const usersAfter = await ctx.db.select({ id: authUsers.id }).from(authUsers);
    expect(usersAfter.map((row) => row.id).sort()).toEqual(usersBefore.map((row) => row.id).sort());
    expect(usersAfter.some((row) => row.id === missingUserId)).toBe(false);
  });

  it("keeps a real user who has no company access instead of replacing that user", async () => {
    const seeded = await seedIssue();
    const outsider = `user-${randomUUID()}`;
    await insertUser(outsider);

    expect(await userHasActiveCompanyAccess(ctx.db, seeded.companyId, outsider)).toBe(false);
    const comment = await issueService(ctx.db).addComment(seeded.issueId, "Attributed to the outsider", {
      agentId: seeded.agentId,
      onBehalfOfUserId: outsider,
    });

    expect(comment.onBehalfOfUserId).toBe(outsider);
    expect(comment.onBehalfOfUserId).not.toBe(seeded.userId);
  });
});
