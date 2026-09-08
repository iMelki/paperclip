import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ingest: vi.fn(), log: vi.fn() }));
vi.mock("../services/index.js", () => ({
  costService: () => ({ createEventWithOutcome: mocks.ingest }),
  budgetService: () => ({}), financeService: () => ({}), companyService: () => ({}),
  agentService: () => ({}), issueService: () => ({}), accessService: () => ({}),
  heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }), logActivity: mocks.log,
}));
vi.mock("../services/quota-windows.js", () => ({ fetchAllQuotaWindows: vi.fn() }));
import { costRoutes } from "../routes/costs.js";
import { HttpError } from "../errors.js";

const companyId = "619a6887-7c99-4b7d-84d4-620d239a46af";
const data = { sourceSystem: "export", sourceAccountId: "account", sourceEventId: "event",
  agentId: "a616ec6b-d5a4-43a9-9151-5376d5c69799", provider: "openai", model: "test-model",
  costCents: 10, occurredAt: "2026-09-01T12:00:00.000Z" };
function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId: "test", source: "local_implicit" }; next(); });
  app.use("/api", costRoutes({} as never));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 400).json({ error: error.message });
  });
  return app;
}
beforeEach(() => { vi.clearAllMocks(); });

describe("cost event source HTTP outcomes", () => {
  it("returns 201 for new events and 200 for replays with one audit event", async () => {
    const event = { ...data, id: "event-row", companyId };
    mocks.ingest.mockResolvedValueOnce({ event, created: true }).mockResolvedValueOnce({ event, created: false });
    const server = app();
    expect((await request(server).post(`/api/companies/${companyId}/cost-events`).send(data)).status).toBe(201);
    const replay = await request(server).post(`/api/companies/${companyId}/cost-events`).send(data);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(event.id);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(companyId, expect.objectContaining({ sourceEventId: "event", occurredAt: expect.any(Date) }));
  });

  it("surfaces immutable replay conflict without recording a new audit event", async () => {
    mocks.ingest.mockRejectedValue(new HttpError(409, "Source event identity already exists with a different cost payload"));
    const result = await request(app()).post(`/api/companies/${companyId}/cost-events`).send(data);
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("different cost payload");
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("rejects unscoped source identities before the cost service runs", async () => {
    const result = await request(app()).post(`/api/companies/${companyId}/cost-events`).send({ ...data, sourceAccountId: null });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("must be supplied together");
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
