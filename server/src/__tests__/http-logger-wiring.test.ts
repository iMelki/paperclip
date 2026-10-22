import { createServer, request } from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";

// Drives the production `httpLogger` exported by middleware/logger.ts (the one
// app.ts mounts), not the factory on its own, so a logger.ts that builds its own
// pinoHttp again cannot pass. pino is wrapped to write JSON into memory.
const chunks = vi.hoisted(() => [] as string[]);
vi.mock("pino", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import("pino").pino }>()).default;
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const wrapped = Object.assign(
    (opts: Record<string, unknown>) => real({ ...opts, level: "debug" }, sink),
    { transport: () => ({}) },
  );
  return { default: wrapped };
});
// logger.ts resolves and creates a log directory at import time.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
}));
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-http-logger-wiring-test"),
}));

const CANARIES = {
  authorizationHeader: "authorization-header-canary-must-not-reach-pino",
  successQuery: "success-query-canary-must-not-reach-pino",
  failureQuery: "failure-query-canary-must-not-reach-pino",
  handoffTicket: "handoff-ticket-canary-must-not-reach-pino",
  signInPassword: "sign-in-password-canary-must-not-reach-pino",
  githubToken: "github-token-canary-must-not-reach-pino",
  clientSecret: "client-secret-canary-must-not-reach-pino",
  plainBinding: "plain-binding-canary-must-not-reach-pino",
  claimPath: "claim-path-canary-must-not-reach-pino",
  secretValue: "secret-value-canary-must-not-reach-pino",
  errorContextMessage: "error-context-message-canary-must-not-reach-pino",
};

describe("production httpLogger wiring", () => {
  it("routes app request logs through the hardened factory so no credential reaches the log", async () => {
    const { httpLogger } = await import("../middleware/logger.js");
    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.get("/ok", (_req, res) => {
      res.status(200).send("ok");
    });
    app.get("/fail", (_req, res) => {
      (res as typeof res & { __errorContext?: unknown }).__errorContext = {
        error: { code: "x", message: CANARIES.errorContextMessage },
      };
      res.status(500).send("failed");
    });
    app.post("/api/auth/sign-in/email", (_req, res) => {
      res.status(401).send("rejected");
    });
    app.post("/api/companies/:companyId/agent-hires", (_req, res) => {
      res.status(422).send("rejected");
    });
    app.post("/api/board-claim/:token/claim", (_req, res) => {
      res.status(422).send("rejected");
    });
    app.post("/api/companies/:companyId/secrets", (_req, res) => {
      res.status(422).send("rejected");
    });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");

    const send = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
      new Promise<void>((resolve, reject) => {
        const client = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method,
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end(body ? JSON.stringify(body) : undefined);
      });

    try {
      await send(`/ok?access_token=${CANARIES.successQuery}`, "GET", undefined, {
        authorization: `Bearer ${CANARIES.authorizationHeader}`,
      });
      await send(`/ok?ticket=${CANARIES.handoffTicket}`);
      await send(`/fail?code=${CANARIES.failureQuery}`);
      await send("/api/auth/sign-in/email", "POST", { email: "a@example.test", password: CANARIES.signInPassword });
      await send("/api/companies/company-1/agent-hires", "POST", {
        adapterConfig: {
          githubToken: CANARIES.githubToken,
          clientSecret: CANARIES.clientSecret,
          env: { DISPLAY_NAME: { type: "plain", value: CANARIES.plainBinding } },
        },
      });
      await send(`/api/board-claim/${CANARIES.claimPath}/claim`, "POST", { label: "claim" });
      await send("/api/companies/company-1/secrets", "POST", { value: CANARIES.secretValue });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    const leaked = Object.entries(CANARIES)
      .filter(([, canary]) => output.includes(canary))
      .map(([name]) => name);
    expect(leaked).toEqual([]);

    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      msg: string;
      reqBody?: Record<string, unknown>;
    }>;
    expect(logs.map((log) => log.msg)).toContain("GET /ok 200");
    const hire = logs.find((log) => log.msg.startsWith("POST /api/companies/company-1/agent-hires"));
    expect(hire?.reqBody).toEqual({
      adapterConfig: {
        githubToken: "[REDACTED]",
        clientSecret: "[REDACTED]",
        env: { DISPLAY_NAME: { type: "plain", value: "[REDACTED]" } },
      },
    });
  });


  async function driveApp(
    register: (app: express.Express) => void,
    requests: Array<[path: string, method: string]>,
    headers: Record<string, string> = {},
  ): Promise<string> {
    chunks.length = 0;
    const { httpLogger } = await import("../middleware/logger.js");
    const { errorHandler } = await import("../middleware/error-handler.js");
    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    register(app);
    app.use(errorHandler);
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
    try {
      for (const [path, method] of requests) {
        await new Promise<void>((resolve, reject) => {
          const client = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, (res) => {
            res.resume();
            res.on("end", resolve);
          });
          client.on("error", reject);
          client.end();
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    return chunks.join("");
  }

  const leakedCanaries = (output: string, canaries: Record<string, string>) =>
    Object.entries(canaries)
      .filter(([, canary]) => output.includes(canary))
      .map(([name]) => name);

  it("keeps the raw res.err message and stack from the real error handler out of the log", async () => {
    const canaries = {
      thrownMessage: "thrown-error-message-canary-must-not-reach-pino",
      httpErrorMessage: "http-error-message-canary-must-not-reach-pino",
    };
    const { HttpError } = await import("../errors.js");
    const output = await driveApp(
      (app) => {
        app.get("/boom", () => {
          throw new Error(`connect failed postgres://paperclip:${canaries.thrownMessage}@db/paperclip`);
        });
        app.get("/boom-http", () => {
          throw new HttpError(502, `upstream rejected ${canaries.httpErrorMessage}`);
        });
      },
      [["/boom", "GET"], ["/boom-http", "GET"]],
    );

    expect(leakedCanaries(output, canaries)).toEqual([]);
    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      msg: string;
      err?: Record<string, unknown>;
    }>;
    const boom = logs.find((log) => log.msg.startsWith("GET /boom 500"));
    expect(boom?.err).toMatchObject({ type: "Error" });
    expect(boom?.err?.message).toBeUndefined();
    expect(String(boom?.err?.stack ?? "")).toMatch(/^\s+at\s/);
    const boomHttp = logs.find((log) => log.msg.startsWith("GET /boom-http 502"));
    expect(boomHttp?.err).toMatchObject({ type: "HttpError", status: 502 });
  });

  it("redacts /api/invites/<token> path tokens from logged url and msg", async () => {
    const canaries = {
      inviteToken: "invite-token-canary-must-not-reach-pino",
      inviteAcceptToken: "invite-accept-token-canary-must-not-reach-pino",
    };
    const output = await driveApp(
      (app) => {
        app.get("/api/invites/:token", (_req, res) => {
          res.status(200).json({ ok: true });
        });
        app.post("/api/invites/:token/accept", (_req, res) => {
          res.status(422).send("rejected");
        });
      },
      [[`/api/invites/${canaries.inviteToken}`, "GET"], [`/api/invites/${canaries.inviteAcceptToken}/accept`, "POST"]],
    );

    expect(leakedCanaries(output, canaries)).toEqual([]);
    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{ msg: string }>;
    expect(logs.map((log) => log.msg)).toContain("GET /api/invites/[REDACTED] 200");
  });

  it("redacts board-claim and invite tokens from msg when routes live on a router mounted at /api", async () => {
    const canaries = {
      claimToken: "mounted-claim-token-canary-must-not-reach-pino",
      inviteToken: "mounted-invite-token-canary-must-not-reach-pino",
      inviteOnboardingToken: "mounted-invite-onboarding-canary-must-not-reach-pino",
    };
    const output = await driveApp(
      (app) => {
        const api = express.Router();
        api.get("/board-claim/:token", (_req, res) => {
          res.status(200).json({ ok: true });
        });
        api.get("/invites/:token", (_req, res) => {
          res.status(200).json({ ok: true });
        });
        api.get("/invites/:token/onboarding", () => {
          throw new Error("onboarding failed");
        });
        app.use("/api", api);
      },
      [
        [`/api/board-claim/${canaries.claimToken}`, "GET"],
        [`/api/invites/${canaries.inviteToken}`, "GET"],
        [`/api/invites/${canaries.inviteOnboardingToken}/onboarding`, "GET"],
      ],
    );

    expect(leakedCanaries(output, canaries)).toEqual([]);
    const msgs = (output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{ msg: string }>)
      .map((log) => log.msg);
    expect(msgs).toContain("GET /api/board-claim/[REDACTED] 200");
    expect(msgs).toContain("GET /api/invites/[REDACTED] 200");
    expect(msgs.some((msg) => msg.startsWith("GET /api/invites/[REDACTED]/onboarding 500"))).toBe(true);
  });

  it("redacts credential headers by name pattern on success, 4xx and 5xx lines", async () => {
    const canaries: Record<string, string> = {
      "x-openclaw-token": "openclaw-token-canary-must-not-reach-pino",
      "x-openclaw-auth": "openclaw-auth-canary-must-not-reach-pino",
      "x-paperclip-cloud-tenant-token": "cloud-tenant-token-canary-must-not-reach-pino",
      "x-paperclip-tool-gateway-token": "tool-gateway-token-canary-must-not-reach-pino",
      "x-paperclip-signature": "paperclip-signature-canary-must-not-reach-pino",
      "x-hub-signature-256": "hub-signature-canary-must-not-reach-pino",
      "x-auth-token": "x-auth-token-canary-must-not-reach-pino",
      "X-Access-Token": "x-access-token-canary-must-not-reach-pino",
      "x-webhook-secret": "webhook-secret-canary-must-not-reach-pino",
      "x-service-key": "service-key-canary-must-not-reach-pino",
    };
    const output = await driveApp(
      (app) => {
        app.get("/hdr-ok", (_req, res) => {
          res.status(200).send("ok");
        });
        app.get("/hdr-422", (_req, res) => {
          res.status(422).send("rejected");
        });
        app.get("/hdr-500", () => {
          throw new Error("failed");
        });
      },
      [["/hdr-ok", "GET"], ["/hdr-422", "GET"], ["/hdr-500", "GET"]],
      { ...canaries, "x-request-id": "request-id-kept" },
    );

    expect(leakedCanaries(output, canaries)).toEqual([]);
    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      msg: string;
      req?: { headers?: Record<string, unknown> };
    }>;
    const headerLines = logs.filter((log) => log.msg.startsWith("GET /hdr-"));
    expect(headerLines).toHaveLength(3);
    for (const line of headerLines) {
      expect(line.req?.headers?.["x-openclaw-token"]).toBe("[Redacted]");
      expect(line.req?.headers?.["x-hub-signature-256"]).toBe("[Redacted]");
      expect(line.req?.headers?.["x-request-id"]).toBe("request-id-kept");
    }
  });
});
