import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertCompanyAccess } from "../routes/authz.js";

const SENTINEL = "built-in-bundles";
const CONFIGURED_ACTOR_ENV = "PAPERCLIP_BUILT_IN_ACTOR_USER_ID";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rowsResult(rows: unknown[]) {
  // Drizzle chains end in a thenable; the owner lookup adds orderBy and limit.
  const result: any = Promise.resolve(rows);
  result.orderBy = () => rowsResult(rows);
  result.limit = () => rowsResult(rows);
  return result;
}

function createDb(input: {
  companyId: string;
  agentId: string;
  keyHash: string;
  responsibleUserId: string;
  userRows: Array<{ id: string }>;
  membershipRows: Array<{ id: string; userId: string; companyId: string; membershipRole: string; status: string }>;
}) {
  const rowsForTable = (table: unknown): unknown[] => {
    if (table === boardApiKeys) return [];
    if (table === agentApiKeys) {
      return [{
        id: randomUUID(),
        agentId: input.agentId,
        companyId: input.companyId,
        keyHash: input.keyHash,
        responsibleUserId: input.responsibleUserId,
        revokedAt: null,
        scopeConfig: null,
      }];
    }
    if (table === agents) return [{ id: input.agentId, companyId: input.companyId, status: "active" }];
    if (table === authUsers) return input.userRows;
    if (table === companyMemberships) return input.membershipRows;
    return [];
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => rowsResult(rowsForTable(table)),
        // The owner lookup joins the user table before it filters and limits.
        innerJoin: () => ({ where: () => rowsResult(rowsForTable(table)) }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("agent key actor for the built-in bundle sentinel", () => {
  const originalConfigured = process.env[CONFIGURED_ACTOR_ENV];

  beforeEach(() => {
    delete process.env[CONFIGURED_ACTOR_ENV];
  });

  afterEach(() => {
    if (originalConfigured === undefined) delete process.env[CONFIGURED_ACTOR_ENV];
    else process.env[CONFIGURED_ACTOR_ENV] = originalConfigured;
  });

  function setup(responsibleUserId: string, eligible: boolean) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = `pcp_test_${randomUUID()}`;
    const ownerUserId = "owner-user";
    const db = createDb({
      companyId,
      agentId,
      keyHash: hashToken(token),
      responsibleUserId,
      userRows: eligible ? [{ id: ownerUserId }] : [],
      membershipRows: eligible
        ? [{ id: randomUUID(), userId: ownerUserId, companyId, membershipRole: "owner", status: "active" }]
        : [],
    });
    return { app: createApp(db), companyId, agentId, token, ownerUserId };
  }

  it("acts as the company owner when the key stores the sentinel and an owner exists", async () => {
    const { app, companyId, agentId, token, ownerUserId } = setup(SENTINEL, true);

    const actor = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(actor.status).toBe(200);
    expect(actor.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: ownerUserId,
      source: "agent_key",
    });

    const protectedRes = await request(app)
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);
    expect(protectedRes.status).toBe(200);
  });

  it("keeps the sentinel and rejects the request when no company user is eligible", async () => {
    const { app, companyId, token } = setup(SENTINEL, false);

    const res = await request(app)
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
  });

  it("leaves an ordinary responsible user untouched", async () => {
    const { app, token } = setup("user-key", true);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.onBehalfOfUserId).toBe("user-key");
  });
});
