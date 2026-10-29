import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiRouteNotFound } from "../middleware/api-route-not-found.js";

describe("API route not found", () => {
  const app = express();
  app.use("/api", apiRouteNotFound);

  it.each([
    "/api/issues/issue-id/subissues",
    "/api/issues",
    "/api/companies/company-id/issues/unknown",
  ])("names the supported issue creation routes for %s", async (route) => {
    const res = await request(app).post(route);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("POST /api/issues/:issueId/children");
    expect(res.body.error).toContain("POST /api/companies/:companyId/issues");
    expect(res.body.error).toContain("parentId");
  });

  it("preserves the generic response outside issue routes", async () => {
    const res = await request(app).post("/api/agents/unknown-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "API route not found" });
  });
});
