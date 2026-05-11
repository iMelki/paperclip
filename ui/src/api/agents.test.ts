import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));

import { agentsApi } from "./agents";

describe("agentsApi.adapterModels", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("includes refresh and environmentId in the request query string", async () => {
    await agentsApi.adapterModels("company-1", "codex_local", {
      refresh: true,
      environmentId: "env-123",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/adapters/codex_local/models?refresh=1&environmentId=env-123",
    );
  });
});
