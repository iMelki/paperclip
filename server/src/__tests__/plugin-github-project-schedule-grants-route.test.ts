import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { registerGitHubProjectScheduleGrantRoutes } from "../routes/plugin-github-project-schedule-grants.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const allowedCompanyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const route = `/api/plugins/${pluginId}/companies/${otherCompanyId}/projects/${projectId}/github-board/schedule-grant`;
const allowedRoute = `/api/plugins/${pluginId}/companies/${allowedCompanyId}/projects/${projectId}/github-board/schedule-grant`;

function appFor(companyIds: string[], role: "owner" | "viewer" = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      sessionId: "session-1",
      userId: "user-1",
      companyIds,
      memberships: companyIds.map((companyId) => ({
        companyId,
        status: "active" as const,
        membershipRole: role,
      })),
    };
    next();
  });
  const router = express.Router();
  registerGitHubProjectScheduleGrantRoutes(router, {} as never);
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

describe("native GitHub board schedule grant routes", () => {
  it("returns 404, not 403, when the caller cannot access the company", async () => {
    const response = await request(appFor([allowedCompanyId])).get(route);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Company not found" });
  });

  it("returns 403 for a viewer of an accessible company", async () => {
    const response = await request(appFor([allowedCompanyId], "viewer")).get(allowedRoute);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Active non-viewer company membership required for board schedule grants");
  });
});
