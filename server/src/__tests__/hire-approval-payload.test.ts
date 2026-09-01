import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../redaction.js";
import {
  enforceHireApprovalPermissionBoundary,
  prepareNormalizedHireApprovalPayloadForPersistence,
  redactHireApprovalConfigForPersistence,
  restoreHireApprovalPayloadFromPendingAgent,
} from "../services/hire-approval-payload.js";
import { secretService } from "../services/secrets.js";

describe("hire approval payload custody", () => {
  it("preserves a restrictive standalone CEO permission snapshot", () => {
    const permissions = {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    };

    const guarded = enforceHireApprovalPermissionBoundary({
      name: "Restricted CEO",
      role: "ceo",
      permissions,
    });

    expect(guarded.permissions).toEqual(permissions);
  });

  it.each([
    ["non-CEO agent creation", "engineer", { canCreateAgents: true }, "permissions.canCreateAgents"],
    ["task assignment", "engineer", { canAssignTasks: true }, "permissions.canAssignTasks"],
    ["future permission", "engineer", { futureAdmin: true }, "permissions.futureAdmin"],
    [
      "complex authorization policy",
      "engineer",
      { authorizationPolicy: { custom: true } },
      "permissions.authorizationPolicy",
    ],
  ])("rejects standalone %s privilege input", (_case, role, permissions, path) => {
    expect(() => enforceHireApprovalPermissionBoundary({ role, permissions })).toThrowError(
      expect.objectContaining({
        status: 422,
        details: {
          code: "hire_approval_permission_escalation",
          path,
          reason: expect.any(String),
        },
      }),
    );
  });

  it("accepts an absent standalone permission snapshot", () => {
    const payload = { name: "Default Agent", role: "engineer" };
    expect(enforceHireApprovalPermissionBoundary(payload)).toEqual({
      ...payload,
      permissions: {
        canCreateAgents: false,
        canCreateSkills: true,
      },
    });
  });

  it("injects the normalized pending-agent permission baseline for board review", () => {
    const guarded = enforceHireApprovalPermissionBoundary(
      { agentId: "agent-1", name: "Pending Agent" },
      { role: "engineer", permissions: { trustPreset: "low_trust_review" } },
    );

    expect(guarded.permissions).toEqual({
      canCreateAgents: false,
      canCreateSkills: true,
      trustPreset: "low_trust_review",
    });
  });

  it("rejects permission changes that differ from the frozen pending-agent baseline", () => {
    expect(() => enforceHireApprovalPermissionBoundary(
      {
        agentId: "agent-1",
        permissions: { canCreateAgents: true, canCreateSkills: true },
      },
      {
        role: "engineer",
        permissions: { canCreateAgents: false, canCreateSkills: true },
      },
    )).toThrowError(expect.objectContaining({
      status: 422,
      details: {
        code: "hire_approval_permission_baseline_mismatch",
        path: "permissions",
      },
    }));
  });

  it("preserves only an exactly empty plain binding while redacting secret values", () => {
    const result = redactHireApprovalConfigForPersistence({
      env: {
        OPENAI_API_KEY: { type: "plain", value: "" },
        NONEMPTY_API_KEY: { type: "plain", value: "sk-live" },
        WHITESPACE_API_KEY: { type: "plain", value: "   " },
        DATABASE_URL: { type: "plain", value: "postgres://user:secret@example.test/db" },
        DISPLAY_NAME: { type: "plain", value: "apparently-benign-but-still-private" },
        REFERENCED_API_KEY: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
      },
    });

    expect(result).toEqual({
      env: {
        OPENAI_API_KEY: { type: "plain", value: "" },
        NONEMPTY_API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
        WHITESPACE_API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
        DATABASE_URL: { type: "plain", value: REDACTED_EVENT_VALUE },
        DISPLAY_NAME: { type: "plain", value: REDACTED_EVENT_VALUE },
        REFERENCED_API_KEY: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
      },
    });
  });

  it("negative-proves the old empty-key failure and the repaired persistence input", async () => {
    const config = {
      env: {
        OPENAI_API_KEY: { type: "plain", value: "" },
      },
    };
    const oldRedacted = redactEventPayload(config) ?? {};
    const repairedRedacted = redactHireApprovalConfigForPersistence(config);
    const secrets = secretService({} as never);

    expect(oldRedacted).not.toEqual(config);
    await expect(
      secrets.normalizeAdapterConfigForPersistence("company-1", oldRedacted),
    ).rejects.toThrow("Refusing to persist redacted placeholder for key: OPENAI_API_KEY");
    await expect(
      secrets.normalizeAdapterConfigForPersistence("company-1", repairedRedacted),
    ).resolves.toEqual(config);
  });

  it("allows exact-empty bindings and secret refs without a pending baseline", () => {
    const payload = prepareNormalizedHireApprovalPayloadForPersistence({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
          REFERENCED_API_KEY: {
            type: "secret_ref",
            secretId: "11111111-1111-1111-1111-111111111111",
            version: "latest",
          },
        },
      },
    });

    expect(payload).toEqual({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
          REFERENCED_API_KEY: {
            type: "secret_ref",
            secretId: "11111111-1111-1111-1111-111111111111",
            version: "latest",
          },
        },
      },
    });
  });

  it.each([
    ["nonempty", "OPENAI_API_KEY", "sk-live"],
    ["whitespace", "OPENAI_API_KEY", "   "],
    ["non-secret-shaped key", "DISPLAY_NAME", "private runtime value"],
  ])("rejects a %s plain binding without a pending baseline", (_case, key, value) => {
    let failure: unknown;
    try {
      prepareNormalizedHireApprovalPayloadForPersistence({
        adapterConfig: {
          env: {
            [key]: { type: "plain", value },
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_secret_baseline_required",
        path: `adapterConfig.env.${key}.value`,
      },
    });
  });

  it("restores redacted values only from the same paths in the pending baseline", () => {
    const restored = restoreHireApprovalPayloadFromPendingAgent(
      {
        name: "Codex",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "" },
            INTERNAL_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
          },
        },
        runtimeConfig: {
          nested: { privateKey: REDACTED_EVENT_VALUE },
        },
      },
      {
        name: "Codex",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "" },
            INTERNAL_TOKEN: { type: "plain", value: "persisted-token" },
          },
        },
        runtimeConfig: {
          nested: { privateKey: "persisted-private-key" },
        },
      },
    );

    expect(restored).toMatchObject({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
          INTERNAL_TOKEN: { type: "plain", value: "persisted-token" },
        },
      },
      runtimeConfig: {
        nested: { privateKey: "persisted-private-key" },
      },
    });
  });

  it("rejects an explicit secret change that cannot be represented by the frozen baseline", () => {
    let failure: unknown;
    try {
      prepareNormalizedHireApprovalPayloadForPersistence(
        {
          adapterConfig: {
            env: {
              OPENAI_API_KEY: { type: "plain", value: "new-secret" },
            },
          },
        },
        {
          adapterConfig: {
            env: {
              OPENAI_API_KEY: { type: "plain", value: "persisted-secret" },
            },
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_secret_baseline_mismatch",
        path: "adapterConfig.env.OPENAI_API_KEY.value",
      },
    });
  });

  it.each([
    ["missing", {}],
    ["sentinel", { INTERNAL_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE } }],
  ])("fails closed when a redacted path has a %s baseline value", (_case, env) => {
    let failure: unknown;
    try {
      restoreHireApprovalPayloadFromPendingAgent(
        {
          adapterConfig: {
            env: {
              INTERNAL_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
            },
          },
        },
        { adapterConfig: { env } },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_redacted_baseline_missing",
        path: "adapterConfig.env.INTERNAL_TOKEN.value",
      },
    });
  });

  it("fails closed on an embedded marker instead of guessing at mixed command text", () => {
    let failure: unknown;
    try {
      restoreHireApprovalPayloadFromPendingAgent(
        {
          adapterConfig: {
            command: `tool --token ${REDACTED_EVENT_VALUE}`,
          },
        },
        {
          adapterConfig: {
            command: "tool --token persisted-token",
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_redacted_baseline_missing",
        path: "adapterConfig",
      },
    });
  });
});
