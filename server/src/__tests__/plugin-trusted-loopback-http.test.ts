import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  setTrustedLoopbackHttpRules,
  type TrustedLoopbackHttpRule,
} from "../services/plugin-trusted-loopback-policy.js";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin host trusted loopback HTTP", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  let origin = "";
  let pluginId = "";
  let companyA = "";
  let companyB = "";
  let callbackTargetRequestCount = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-loopback-http-");
    db = createDb(tempDb.connectionString);

    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/callbacks/run-1") {
        callbackTargetRequestCount += 1;
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end('{"accepted":true}');
        return;
      }
      if (req.method === "POST" && req.url === "/api/callbacks/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/api/callbacks/run-1");
        res.end("redirect");
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;

    pluginId = randomUUID();
    companyA = randomUUID();
    companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Loopback A", issuePrefix: "LBA" },
      { id: companyB, name: "Loopback B", issuePrefix: "LBB" },
    ]);
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.loopback-test",
      packageName: "@paperclipai/plugin-loopback-test",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.loopback-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Loopback Test",
        description: "Loopback Test",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["http.outbound"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });

    const rules: TrustedLoopbackHttpRule[] = [{
      method: "POST",
      origin,
      pathnamePattern: "/api/callbacks/*",
    }];
    const registry = pluginRegistryService(db);
    await registry.upsertCompanySettings(pluginId, companyA, {
      settingsJson: { pluginOwned: true },
    });
    await registry.setCompanyTrustedLoopbackHttpRules(pluginId, companyA, rules);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await tempDb?.cleanup();
  });

  it("allows only the configured company/method/path tuple", async () => {
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.loopback-test",
      createEventBusStub(),
    );

    await expect(services.http.fetch({
      url: `${origin}/api/callbacks/run-1`,
      init: { method: "POST" },
      companyId: companyA,
    })).resolves.toMatchObject({
      status: 202,
      body: '{"accepted":true}',
    });
  });

  it("keeps host rules authoritative across stale plugin writes and revocation", async () => {
    const registry = pluginRegistryService(db);
    const rules: TrustedLoopbackHttpRule[] = [{
      method: "POST",
      origin,
      pathnamePattern: "/api/callbacks/*",
    }];
    const staleBeforeGrant = {
      pluginOwned: { generation: 1 },
      __paperclipHost: {
        trustedLoopbackHttpRules: [{
          method: "GET",
          origin,
          pathnamePattern: "/stale-before-grant",
        }],
      },
    };

    await registry.setCompanyTrustedLoopbackHttpRules(pluginId, companyB, rules);
    await registry.upsertCompanySettings(pluginId, companyB, {
      settingsJson: staleBeforeGrant,
    });
    expect(
      (await registry.getCompanySettings(pluginId, companyB))?.settingsJson,
    ).toMatchObject({
      pluginOwned: { generation: 1 },
      __paperclipHost: { trustedLoopbackHttpRules: rules },
    });

    const staleBeforeRevocation = setTrustedLoopbackHttpRules(
      { pluginOwned: { generation: 2 } },
      rules,
    );
    await registry.setCompanyTrustedLoopbackHttpRules(pluginId, companyB, []);
    await registry.upsertCompanySettings(pluginId, companyB, {
      settingsJson: staleBeforeRevocation,
    });
    expect(
      (await registry.getCompanySettings(pluginId, companyB))?.settingsJson,
    ).toMatchObject({
      pluginOwned: { generation: 2 },
      __paperclipHost: { trustedLoopbackHttpRules: [] },
    });
  });

  it.each([
    ["missing company scope", undefined, "POST", "/api/callbacks/run-1"],
    ["another company", companyB, "POST", "/api/callbacks/run-1"],
    ["wrong method", companyA, "GET", "/api/callbacks/run-1"],
    ["undeclared path", companyA, "POST", "/api/private/run-1"],
    ["empty wildcard segment", companyA, "POST", "/api/callbacks/"],
  ])("keeps default loopback blocking for %s", async (_label, companyId, method, pathname) => {
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.loopback-test",
      createEventBusStub(),
    );

    await expect(services.http.fetch({
      url: `${origin}${pathname}`,
      init: { method },
      companyId,
    })).rejects.toThrow(/private\/reserved ranges/);
  });

  it("rejects query-bearing loopback URLs even when the path otherwise matches", async () => {
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.loopback-test",
      createEventBusStub(),
    );

    await expect(services.http.fetch({
      url: `${origin}/api/callbacks/run-1?redirect=http://127.0.0.1`,
      init: { method: "POST" },
      companyId: companyA,
    })).rejects.toThrow(/query string or fragment/);
  });

  it("returns redirects without following them to a second loopback request", async () => {
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.loopback-test",
      createEventBusStub(),
    );
    const before = callbackTargetRequestCount;

    await expect(services.http.fetch({
      url: `${origin}/api/callbacks/redirect`,
      init: { method: "POST" },
      companyId: companyA,
    })).resolves.toMatchObject({
      status: 302,
      headers: expect.objectContaining({ location: "/api/callbacks/run-1" }),
      body: "redirect",
    });
    expect(callbackTargetRequestCount).toBe(before);
  });
});
