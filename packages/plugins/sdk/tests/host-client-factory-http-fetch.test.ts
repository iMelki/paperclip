import { describe, expect, it, vi } from "vitest";
import {
  createHostClientHandlers,
  InvocationScopeDeniedError,
  type HostServices,
} from "../src/host-client-factory.js";

function createHandlers(fetch = vi.fn(async () => ({
  status: 200,
  statusText: "OK",
  headers: {},
  body: "ok",
}))) {
  return {
    fetch,
    handlers: createHostClientHandlers({
      pluginId: "test.http-scope",
      capabilities: ["http.outbound"],
      services: {
        http: { fetch },
      } as unknown as HostServices,
    }),
  };
}

describe("host client scoped HTTP handler", () => {
  it("derives companyId from a host-issued invocation", async () => {
    const { fetch, handlers } = createHandlers();

    await handlers["http.fetch"](
      { url: "http://127.0.0.1:3021/health" },
      { invocationScope: { companyId: "company-1" } },
    );

    expect(fetch).toHaveBeenCalledWith({
      url: "http://127.0.0.1:3021/health",
      companyId: "company-1",
    });
  });

  it("preserves an explicit matching companyId for proactive calls", async () => {
    const { fetch, handlers } = createHandlers();

    await handlers["http.fetch"](
      {
        url: "http://127.0.0.1:3021/health",
        companyId: "company-1",
      },
      { invocationScope: { companyId: "company-1" } },
    );

    expect(fetch).toHaveBeenCalledWith({
      url: "http://127.0.0.1:3021/health",
      companyId: "company-1",
    });
  });

  it("rejects an explicit company that conflicts with invocation scope", async () => {
    const { fetch, handlers } = createHandlers();

    await expect(handlers["http.fetch"](
      {
        url: "http://127.0.0.1:3021/health",
        companyId: "company-2",
      },
      { invocationScope: { companyId: "company-1" } },
    )).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
