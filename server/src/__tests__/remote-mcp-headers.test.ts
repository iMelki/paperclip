import { describe, expect, it } from "vitest";
import {
  buildRemoteMcpHeaders,
  readRemoteMcpHeaderPolicy,
  RemoteMcpHeaderValidationError,
} from "../services/remote-mcp-headers.js";

describe("remote MCP header policy", () => {
  it("accepts array and object static-header forms from config or transport config", () => {
    const arrayPolicy = readRemoteMcpHeaderPolicy({
      config: {
        headerPolicy: {
          staticHeaders: [
            { name: "X-MCP-Toolsets", value: "repos,projects" },
            { name: "X-MCP-Readonly", value: "true" },
          ],
        },
      },
    });
    expect(arrayPolicy.version).toBe(1);
    expect(arrayPolicy.staticHeaders).toEqual([
      { name: "x-mcp-toolsets", value: "repos,projects" },
      { name: "x-mcp-readonly", value: "true" },
    ]);

    expect(readRemoteMcpHeaderPolicy({
      config: { headerPolicy: null },
      transportConfig: {
        headerPolicy: {
          staticHeaders: {
            "X-MCP-Lockdown": "true",
          },
        },
      },
    }).staticHeaders).toEqual([
      { name: "x-mcp-lockdown", value: "true" },
    ]);
  });

  it("keeps protocol and managed credential headers authoritative", () => {
    const result = buildRemoteMcpHeaders({
      connection: {
        config: {
          headerPolicy: {
            passthrough: {
              allowedHeaders: ["X-Client-Request-Id", "Authorization"],
            },
            staticHeaders: [
              { name: "Accept", value: "text/plain" },
              { name: "Content-Type", value: "text/plain" },
              { name: "X-MCP-Toolsets", value: "repos,projects" },
              { name: "X-Client-Request-Id", value: "static-request" },
            ],
            metadata: { forward: ["agent_id"] },
          },
        },
      },
      credentialHeaders: {
        Authorization: "Bearer managed",
      },
      callerHeaders: {
        Authorization: "Bearer caller",
        "X-Client-Request-Id": "caller-request",
      },
      metadataValues: {
        agent_id: "agent-123",
      },
    });

    expect(result.headers).toEqual({
      authorization: "Bearer managed",
      "x-client-request-id": "static-request",
      "x-mcp-toolsets": "repos,projects",
      "x-paperclip-agent-id": "agent-123",
    });
    expect(result.summary).toMatchObject({
      credentialHeaderNames: ["authorization"],
      staticHeaderNames: ["x-client-request-id", "x-mcp-toolsets"],
      passthroughHeaderNames: ["x-client-request-id"],
      droppedPassthroughHeaderNames: ["authorization"],
      metadataHeaderNames: ["x-paperclip-agent-id"],
      collisionRules: expect.arrayContaining([
        { header: "accept", source: "static", action: "dropped_reserved_header" },
        { header: "content-type", source: "static", action: "dropped_reserved_header" },
        { header: "authorization", source: "caller", action: "kept_managed_credential" },
      ]),
    });
    expect(JSON.stringify(result.summary)).not.toContain("Bearer");
    expect(JSON.stringify(result.summary)).not.toContain("repos,projects");
  });

  it("drops sensitive caller passthrough even when configured", () => {
    const result = buildRemoteMcpHeaders({
      connection: {
        config: {
          headerPolicy: {
            allowedPassthroughHeaders: [
              "X-Auth-Token",
              "X-Paperclip-Tool-Gateway-Token",
              "X-Request-Id",
            ],
          },
        },
      },
      callerHeaders: {
        "X-Auth-Token": "do-not-forward",
        "X-Paperclip-Tool-Gateway-Token": "do-not-forward",
        "X-Request-Id": "request-123",
      },
    });

    expect(result.headers).toEqual({ "x-request-id": "request-123" });
    expect(result.summary.droppedPassthroughHeaderNames).toEqual([
      "x-auth-token",
      "x-paperclip-tool-gateway-token",
    ]);
  });

  it("drops every hop-by-hop header across caller, static, and credential sources", () => {
    const result = buildRemoteMcpHeaders({
      connection: {
        config: {
          headerPolicy: {
            allowedPassthroughHeaders: ["Keep-Alive", "Proxy-Connection", "TE"],
            staticHeaders: [
              { name: "Transfer-Encoding", value: "chunked" },
              { name: "Upgrade", value: "websocket" },
            ],
          },
        },
      },
      credentialHeaders: {
        Trailer: "X-Checksum",
      },
      callerHeaders: {
        "Keep-Alive": "timeout=5",
        "Proxy-Connection": "keep-alive",
        TE: "trailers",
      },
    });

    expect(result.headers).toEqual({});
    expect(result.summary.droppedPassthroughHeaderNames).toEqual([
      "keep-alive",
      "proxy-connection",
      "te",
    ]);
    expect(result.summary.collisionRules).toEqual(expect.arrayContaining([
      { header: "keep-alive", source: "caller", action: "dropped_reserved_header" },
      { header: "proxy-connection", source: "caller", action: "dropped_reserved_header" },
      { header: "te", source: "caller", action: "dropped_reserved_header" },
      { header: "transfer-encoding", source: "static", action: "dropped_reserved_header" },
      { header: "upgrade", source: "static", action: "dropped_reserved_header" },
      { header: "trailer", source: "credential", action: "dropped_reserved_header" },
    ]));
  });

  it.each([
    { name: "Authorization", form: "array" },
    { name: "Cookie", form: "object" },
    { name: "X-Api-Key", form: "array" },
    { name: "X-Paperclip-Tool-Gateway-Token", form: "object" },
    { name: "X-Credential", form: "array" },
    { name: "X-Password", form: "object" },
    { name: "X-JWT", form: "array" },
    { name: "X-Bearer", form: "object" },
    { name: "X-Access-Key-Id", form: "array" },
    { name: "X-Private-Key", form: "object" },
    { name: "X-Refresh-Token", form: "array" },
    { name: "X-Client-Secret", form: "object" },
    { name: "X-SecretToken", form: "array" },
    { name: "X-ApiSecret", form: "object" },
  ])("rejects a secret-bearing static $name header in $form form", ({ name, form }) => {
    const sentinel = "static-secret-sentinel";
    const staticHeaders = form === "array"
      ? [{ name, value: sentinel }]
      : { [name]: sentinel };
    let caught: unknown;
    try {
      buildRemoteMcpHeaders({
        connection: {
          config: {
            headerPolicy: {
              staticHeaders,
            },
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RemoteMcpHeaderValidationError);
    expect(caught).toMatchObject({ reason: "sensitive_static_header" });
    expect((caught as Error).message).not.toContain(name);
    expect((caught as Error).message).not.toContain(sentinel);
  });

  it.each([
    "Bearer credential-sentinel",
    " \tBearer credential-sentinel\t ",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.signature-sentinel",
    "ghp_1234567890abcdefghijklmnopqrst",
    "sk-proj-1234567890abcdefghijklmnopqrst",
    "api_key=credential-sentinel",
    "-----BEGIN PRIVATE KEY-----",
  ])(
    "rejects a high-confidence secret value under an otherwise benign static header",
    (value) => {
      let caught: unknown;
      try {
        readRemoteMcpHeaderPolicy({
          config: {
            headerPolicy: {
              staticHeaders: [{ name: "X-MCP-Metadata", value }],
            },
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RemoteMcpHeaderValidationError);
      expect(caught).toMatchObject({ reason: "sensitive_static_header" });
      expect((caught as Error).message).not.toContain(value);
    },
  );

  it("rejects unsupported explicit policy versions while treating an omitted version as v1", () => {
    expect(readRemoteMcpHeaderPolicy({ config: { headerPolicy: {} } }).version).toBe(1);
    expect(() => readRemoteMcpHeaderPolicy({
      config: { headerPolicy: { version: 2 } },
    })).toThrowError(RemoteMcpHeaderValidationError);

    try {
      readRemoteMcpHeaderPolicy({ config: { headerPolicy: { version: 2 } } });
    } catch (error) {
      expect(error).toMatchObject({ reason: "invalid_policy" });
    }
  });

  it.each([
    {
      label: "malformed name",
      connection: {
        config: {
          headerPolicy: {
            staticHeaders: [{ name: "X-Bad Header", value: "name-sentinel" }],
          },
        },
      },
      sentinel: "X-Bad Header",
    },
    {
      label: "newline-bearing static value",
      connection: {
        config: {
          headerPolicy: {
            staticHeaders: [{ name: "X-Good", value: "value-sentinel\r\nInjected: true" }],
          },
        },
      },
      sentinel: "value-sentinel",
    },
    {
      label: "NUL-bearing static value",
      connection: {
        config: {
          headerPolicy: {
            staticHeaders: [{ name: "X-Good", value: "value-sentinel\u0000hidden" }],
          },
        },
      },
      sentinel: "value-sentinel",
    },
    {
      label: "non-ByteString static value",
      connection: {
        config: {
          headerPolicy: {
            staticHeaders: [{ name: "X-Good", value: "value-sentinel-😃" }],
          },
        },
      },
      sentinel: "value-sentinel",
    },
  ])("rejects a $label without echoing input", ({ connection, sentinel }) => {
    let caught: unknown;
    try {
      buildRemoteMcpHeaders({ connection });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteMcpHeaderValidationError);
    expect((caught as RemoteMcpHeaderValidationError).code).toBe("remote_mcp_header_policy_invalid");
    expect((caught as Error).message).not.toContain(sentinel);
  });

  it("rejects newline-bearing managed credentials without echoing the value", () => {
    const sentinel = "managed-sentinel";
    expect(() => buildRemoteMcpHeaders({
      connection: { config: {} },
      credentialHeaders: {
        Authorization: `${sentinel}\r\nInjected: true`,
      },
    })).toThrowError(RemoteMcpHeaderValidationError);

    try {
      buildRemoteMcpHeaders({
        connection: { config: {} },
        credentialHeaders: {
          Authorization: `${sentinel}\r\nInjected: true`,
        },
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(sentinel);
    }
  });
});
