import { createServer, request } from "node:http";
import { Writable } from "node:stream";
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
    expect(output).not.toMatch(/auth-secret|request-secret|proxy-secret|response-secret/);

    const log = JSON.parse(output.trim()) as {
      req: { headers: Record<string, string> };
      res: { headers: Record<string, string> };
    };
    expect(log.req.headers.authorization).toBe("[Redacted]");
    expect(log.req.headers.cookie).toBe("[Redacted]");
    expect(log.req.headers["set-cookie"]).toBe("[Redacted]");
    expect(log.res.headers["set-cookie"]).toBe("[Redacted]");
  });

  it("does not emit supported camelCase adapter credentials on a rejected request", async () => {
    const canaries = {
      token: "openclaw-auth-canary-must-not-reach-pino",
      devicePrivateKeyPem: "openclaw-pem-canary-must-not-reach-pino",
      githubToken: "github-canary-must-not-reach-pino",
      clientSecret: "client-secret-canary-must-not-reach-pino",
      accessToken: "access-token-canary-must-not-reach-pino",
      privateKey: "private-key-canary-must-not-reach-pino",
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
    const server = createServer((req, res) => {
      res.statusCode = 422;
      (req as typeof req & { body: Record<string, unknown> }).body = {
        adapterConfig: {
          ...canaries,
          monkey: "banana",
          tokenCount: 42,
        },
      };
      httpLogger(req, res);
      res.end("rejected");
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
            path: "/companies/company-1/agent-hires",
            method: "POST",
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
      monkey: "banana",
      tokenCount: 42,
    });
  });
});
