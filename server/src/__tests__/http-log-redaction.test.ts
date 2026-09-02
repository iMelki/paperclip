import { createServer, request } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/http-logger.js";

describe("HTTP logger redaction", () => {
  it("defines the HTTP auth and cookie header paths that must be redacted", () => {
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.cookie");
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["proxy-authorization"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-csrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-xsrf-token"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-api-key"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.referer");
    expect(HTTP_LOG_REDACT_PATHS).toContain("req.headers.referrer");
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-forwarded-uri"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-original-url"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers["x-rewrite-url"]');
    expect(HTTP_LOG_REDACT_PATHS).toContain("res.headers.location");
  });

  it("redacts request and response header secrets from pino-http output", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream);
    const httpLogger = pinoHttp({ logger });
    const server = createServer((req, res) => {
      httpLogger(req, res);
      res.setHeader("set-cookie", "sid=response-secret");
      res.setHeader("location", "/oauth/callback?code=location-query-secret");
      res.end("ok");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server to listen on an ephemeral TCP port");
      }

      await new Promise<void>((resolve, reject) => {
        const client = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/redaction-check",
            headers: {
              authorization: "Bearer auth-secret",
              cookie: "sid=request-secret",
              "set-cookie": "proxy-secret",
              referer: "https://paperclip.test/onboarding?code=referer-query-secret",
              referrer: "https://paperclip.test/onboarding?token=referrer-query-secret",
              "x-forwarded-uri": "/onboarding?code=forwarded-query-secret",
              "x-original-url": "/onboarding?token=original-query-secret",
              "x-rewrite-url": "/onboarding?signature=rewrite-query-secret",
            },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end();
      });

      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    expect(output).not.toMatch(
      /auth-secret|request-secret|proxy-secret|response-secret|referer-query-secret|referrer-query-secret|forwarded-query-secret|original-query-secret|rewrite-query-secret|location-query-secret/,
    );

    const log = JSON.parse(output.trim()) as {
      req: { headers: Record<string, string> };
      res: { headers: Record<string, string> };
    };
    expect(log.req.headers.authorization).toBe("[Redacted]");
    expect(log.req.headers.cookie).toBe("[Redacted]");
    expect(log.req.headers["set-cookie"]).toBe("[Redacted]");
    expect(log.req.headers.referer).toBe("[Redacted]");
    expect(log.req.headers.referrer).toBe("[Redacted]");
    expect(log.req.headers["x-forwarded-uri"]).toBe("[Redacted]");
    expect(log.req.headers["x-original-url"]).toBe("[Redacted]");
    expect(log.req.headers["x-rewrite-url"]).toBe("[Redacted]");
    expect(log.res.headers["set-cookie"]).toBe("[Redacted]");
    expect(log.res.headers.location).toBe("[Redacted]");
  });

  it("removes query secrets from success and error request logs", async () => {
    const successCanary = "success-query-canary-must-not-reach-pino";
    const contextQueryCanary = "context-query-canary-must-not-reach-pino";
    const requestQueryCanary = "request-query-canary-must-not-reach-pino";
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({}, stream);
    const httpLogger = createHttpLogger(logger);
    const app = express();
    app.use(httpLogger);
    app.get("/success", (_req, res) => {
      res.status(200).send("done");
    });
    app.get("/failure-context", (_req, res) => {
      (res as typeof res & {
        __errorContext?: { error: { message: string }; reqQuery: Record<string, string> };
      }).__errorContext = {
        error: { message: "context failure" },
        reqQuery: { code: contextQueryCanary },
      };
      res.status(500).send("done");
    });
    app.get("/failure-request", (_req, res) => {
      (res as typeof res & { err?: Error }).err = new Error("request failure");
      res.status(500).send("done");
    });
    const server = createServer(app);

    const send = (path: string) => new Promise<void>((resolve, reject) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected server to listen on an ephemeral TCP port"));
        return;
      }
      const client = request(
        { hostname: "127.0.0.1", port: address.port, path },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      client.on("error", reject);
      client.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      await send(`/success?access_token=${successCanary}`);
      await send(`/failure-context?code=${contextQueryCanary}`);
      await send(`/failure-request?code=${requestQueryCanary}`);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    expect(output).not.toContain(successCanary);
    expect(output).not.toContain(contextQueryCanary);
    expect(output).not.toContain(requestQueryCanary);
    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      msg: string;
      req: { url: string; query?: unknown; params?: unknown };
    }>;
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      msg: "GET /success 200",
      req: { url: "/success" },
    });
    expect(logs[1]).toMatchObject({
      msg: "GET /failure-context 500 — context failure",
      req: { url: "/failure-context" },
    });
    expect(logs[2]).toMatchObject({
      msg: "GET /failure-request 500 — request failure",
      req: { url: "/failure-request" },
    });
    expect(logs.every((log) => log.req.query === undefined && log.req.params === undefined)).toBe(true);
  });

  it("does not emit supported camelCase adapter credentials on a rejected request", async () => {
    const canaries = {
      token: "openclaw-auth-canary-must-not-reach-pino",
      devicePrivateKeyPem: "openclaw-pem-canary-must-not-reach-pino",
      githubToken: "github-canary-must-not-reach-pino",
      clientSecret: "client-secret-canary-must-not-reach-pino",
      accessToken: "access-token-canary-must-not-reach-pino",
      privateKey: "private-key-canary-must-not-reach-pino",
      plainBinding: "plain-binding-canary-must-not-reach-pino",
      apiBaseUrl: "https://url-user:url-pass@example.test/run?token=url-query-canary#url-fragment-canary",
      redirectUri: "https://example.test/callback?code=redirect-query-canary",
    };
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({}, stream);
    const httpLogger = createHttpLogger(logger);
    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.post("/companies/:companyId/agent-hires", (_req, res) => {
      res.status(422).send("rejected");
    });
    const server = createServer(app);
    const requestBody = {
      adapterConfig: {
        token: canaries.token,
        devicePrivateKeyPem: canaries.devicePrivateKeyPem,
        githubToken: canaries.githubToken,
        clientSecret: canaries.clientSecret,
        accessToken: canaries.accessToken,
        privateKey: canaries.privateKey,
        apiBaseUrl: canaries.apiBaseUrl,
        redirectUri: canaries.redirectUri,
        env: {
          DISPLAY_NAME: { type: "plain", value: canaries.plainBinding },
        },
        monkey: "banana",
        tokenCount: 42,
      },
    };

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server to listen on an ephemeral TCP port");
      }

      await new Promise<void>((resolve, reject) => {
        const client = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/companies/company-1/agent-hires",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end(JSON.stringify(requestBody));
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    for (const canary of Object.values(canaries)) {
      expect(output).not.toContain(canary);
    }
    const log = JSON.parse(output.trim()) as {
      reqBody: { adapterConfig: Record<string, unknown> };
    };
    expect(log.reqBody.adapterConfig).toEqual({
      token: "[REDACTED]",
      devicePrivateKeyPem: "[REDACTED]",
      githubToken: "[REDACTED]",
      clientSecret: "[REDACTED]",
      accessToken: "[REDACTED]",
      privateKey: "[REDACTED]",
      apiBaseUrl: "https://example.test/run",
      redirectUri: "https://example.test/callback",
      env: {
        DISPLAY_NAME: { type: "plain", value: "[REDACTED]" },
      },
      monkey: "banana",
      tokenCount: 42,
    });
  });

  it("omits rejected credential and secret-write bodies plus claim path credentials", async () => {
    const claimPathCanary = "claim-path-canary-must-not-reach-pino";
    const claimCodeCanary = "claim-code-canary-must-not-reach-pino";
    const directValueCanary = "secret-value-canary-must-not-reach-pino";
    const plainBindingCanary = "secret-binding-canary-must-not-reach-pino";
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({}, stream);
    const httpLogger = createHttpLogger(logger);
    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.post("/api/board-claim/:token/claim", (_req, res) => {
      res.status(422).send("rejected");
    });
    app.post("/api/companies/:companyId/secrets", (_req, res) => {
      res.status(422).send("rejected");
    });
    const server = createServer(app);

    const send = (path: string, body: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected server to listen on an ephemeral TCP port"));
        return;
      }
      const client = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      client.on("error", reject);
      client.end(JSON.stringify(body));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      await send(`/API/Board-Claim/${claimPathCanary}/claim`, {
        code: claimCodeCanary,
        label: "claim diagnostic",
      });
      await send("/API/companies/company-1/SECRETS", {
        value: directValueCanary,
        env: {
          DISPLAY_NAME: { type: "plain", value: plainBindingCanary },
        },
        label: "secret diagnostic",
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    const output = chunks.join("");
    for (const canary of [
      claimPathCanary,
      claimCodeCanary,
      directValueCanary,
      plainBindingCanary,
    ]) {
      expect(output).not.toContain(canary);
    }
    const logs = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      req: { url: string };
      reqBody?: unknown;
    }>;
    expect(logs).toHaveLength(2);
    expect(logs[0].req.url).toBe("/API/Board-Claim/[REDACTED]/claim");
    expect(logs[0].reqBody).toBeUndefined();
    expect(logs[1].reqBody).toBeUndefined();
  });
});
