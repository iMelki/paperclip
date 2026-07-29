import { describe, expect, it } from "vitest";
import {
  connectToolAppSchema,
  connectionTokenRequestSchema,
  createToolConnectionSchema,
  putToolConnectionInstallsSchema,
  reviewToolConnectionCatalogSchema,
  startConnectionAuthorizationSchema,
  toolCredentialSecretRefSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
} from "./tool-access.js";

describe("tool access validators", () => {
  it("defaults connection token subjects to app", () => {
    expect(connectionTokenRequestSchema.parse({})).toEqual({ subject: { type: "app" } });
  });

  it("accepts user subjects, grant selection, and authorization input", () => {
    const request = connectionTokenRequestSchema.parse({
      subject: { type: "user", userId: "user-123" },
      grantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request.subject).toEqual({ type: "user", userId: "user-123" });
    expect(startConnectionAuthorizationSchema.parse({ subjectUserId: "user-123", scopes: ["read"] })).toEqual({
      subjectUserId: "user-123",
      scopes: ["read"],
    });
  });

  it("accepts multi-key credential annotations", () => {
    const parsed = toolCredentialSecretRefSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      configPath: "credentials.apiKey",
      keyScope: "production",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parsed.keyScope).toBe("production");
  });
  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts non-secret gallery header policy and rejects nested raw credentials", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "github",
      configValues: {
        headerPolicy: {
          staticHeaders: [
            { name: "X-MCP-Toolsets", value: "repos,projects" },
            { name: "X-MCP-Readonly", value: "true" },
          ],
        },
      },
    }).success).toBe(true);

    const parsed = connectToolAppSchema.safeParse({
      galleryKey: "github",
      configValues: {
        nested: {
          apiKey: "raw-secret",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it.each([
    {
      label: "array-form Authorization static header",
      configValues: {
        headerPolicy: {
          staticHeaders: [{ name: "Authorization", value: "Bearer must-not-persist" }],
        },
      },
    },
    {
      label: "object-form API key static header",
      configValues: {
        headerPolicy: {
          staticHeaders: { "X-Api-Key": "must-not-persist" },
        },
      },
    },
    {
      label: "array-form credential static header",
      configValues: {
        headerPolicy: {
          staticHeaders: [{ name: "X-Credential", value: "must-not-persist" }],
        },
      },
    },
    {
      label: "object-form password static header",
      configValues: {
        headerPolicy: {
          staticHeaders: { "X-Password": "must-not-persist" },
        },
      },
    },
    {
      label: "array-form JWT static header",
      configValues: {
        headerPolicy: {
          staticHeaders: [{ name: "X-JWT", value: "must-not-persist" }],
        },
      },
    },
    {
      label: "object-form bearer static header",
      configValues: {
        headerPolicy: {
          staticHeaders: { "X-Bearer": "must-not-persist" },
        },
      },
    },
    {
      label: "array-form access-key static header",
      configValues: {
        headerPolicy: {
          staticHeaders: [{ name: "X-Access-Key-Id", value: "must-not-persist" }],
        },
      },
    },
    {
      label: "object-form private-key static header",
      configValues: {
        headerPolicy: {
          staticHeaders: { "X-Private-Key": "must-not-persist" },
        },
      },
    },
    {
      label: "unsupported header policy version",
      configValues: {
        headerPolicy: {
          version: 2,
          staticHeaders: [{ name: "X-MCP-Readonly", value: "true" }],
        },
      },
    },
  ])("rejects $label before app configuration can be persisted", ({ configValues }) => {
    const parsed = connectToolAppSchema.safeParse({
      galleryKey: "github",
      configValues,
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    {
      label: "array-form bearer value under a benign name",
      staticHeaders: [
        { name: "X-MCP-Metadata", value: "Bearer must-not-persist" },
      ],
    },
    {
      label: "object-form provider token under a benign name",
      staticHeaders: {
        "X-MCP-Metadata": "ghp_1234567890abcdefghijklmnopqrst",
      },
    },
    {
      label: "array-form whitespace-padded bearer value",
      staticHeaders: [
        { name: "X-MCP-Metadata", value: " \tBearer must-not-persist\t " },
      ],
    },
    {
      label: "object-form NUL-bearing value",
      staticHeaders: {
        "X-MCP-Metadata": "must-not-persist\u0000hidden",
      },
    },
    {
      label: "array-form non-ByteString value",
      staticHeaders: [
        { name: "X-MCP-Metadata", value: "must-not-persist-😃" },
      ],
    },
  ])("rejects $label", ({ staticHeaders }) => {
    const parsed = connectToolAppSchema.safeParse({
      galleryKey: "github",
      configValues: {
        headerPolicy: {
          staticHeaders,
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).not.toContain(
        "must-not-persist",
      );
      expect(JSON.stringify(parsed.error.issues)).not.toContain(
        "ghp_1234567890abcdefghijklmnopqrst",
      );
    }
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });

  it("defaults omitted install access mode at the service boundary while accepting both explicit modes", () => {
    expect(putToolConnectionInstallsSchema.parse({ installs: [] })).toEqual({
      installs: [],
    });
    expect(putToolConnectionInstallsSchema.parse({
      accessMode: "reachability_only",
      installs: [],
    }).accessMode).toBe("reachability_only");
    expect(putToolConnectionInstallsSchema.parse({
      accessMode: "extend_connection_access",
      installs: [],
    }).accessMode).toBe("extend_connection_access");
  });

  it("accepts strict compare-and-set catalog review decisions", () => {
    const parsed = reviewToolConnectionCatalogSchema.parse({
      decisions: [{
        catalogEntryId: "11111111-1111-4111-8111-111111111111",
        decision: "activate",
        expectedVersionHash: "a".repeat(64),
        expectedSchemaHash: "b".repeat(64),
      }],
    });
    expect(parsed.decisions).toHaveLength(1);
  });

  it.each([
    {
      label: "duplicate entry",
      body: {
        decisions: [
          {
            catalogEntryId: "11111111-1111-4111-8111-111111111111",
            decision: "activate",
            expectedVersionHash: "a".repeat(64),
            expectedSchemaHash: "b".repeat(64),
          },
          {
            catalogEntryId: "11111111-1111-4111-8111-111111111111",
            decision: "keep_quarantined",
            expectedVersionHash: "a".repeat(64),
            expectedSchemaHash: "b".repeat(64),
          },
        ],
      },
    },
    {
      label: "prefixed digest",
      body: {
        decisions: [{
          catalogEntryId: "11111111-1111-4111-8111-111111111111",
          decision: "activate",
          expectedVersionHash: `sha256:${"a".repeat(64)}`,
          expectedSchemaHash: "b".repeat(64),
        }],
      },
    },
    {
      label: "unknown field",
      body: {
        decisions: [{
          catalogEntryId: "11111111-1111-4111-8111-111111111111",
          decision: "activate",
          expectedVersionHash: "a".repeat(64),
          expectedSchemaHash: "b".repeat(64),
          unexpected: true,
        }],
      },
    },
  ])("rejects catalog review $label", ({ body }) => {
    expect(reviewToolConnectionCatalogSchema.safeParse(body).success).toBe(false);
  });
});
