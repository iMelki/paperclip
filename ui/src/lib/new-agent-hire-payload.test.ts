// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload.js";
import { defaultCreateValues } from "../components/agent-config-defaults.js";

describe("buildNewAgentHirePayload", () => {
  it("persists the selected default environment id", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Linux Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
          defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
        },
        adapterConfig: { foo: "bar" },
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 0,
    });
  });

  it("sends null when no default environment is selected", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Local Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
        },
        adapterConfig: {},
      }),
    ).toMatchObject({
      defaultEnvironmentId: null,
    });
  });

  it("includes core trust preset permissions when provided", () => {
    expect(
      buildNewAgentHirePayload({
        name: "PR Reviewer",
        effectiveRole: "engineer",
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex_local",
        },
        adapterConfig: {},
        permissions: {
          canCreateAgents: false,
          trustPreset: "low_trust_review",
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            reviewPreset: {
              id: "low_trust_review",
              version: 1,
              rawOutputDisposition: "quarantine",
            },
            trustBoundary: {
              mode: "low_trust_review",
              companyId: "company-1",
              rootIssueId: "issue-root",
            },
          },
        },
      }),
    ).toMatchObject({
      permissions: {
        canCreateAgents: false,
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
          trustBoundary: {
            mode: "low_trust_review",
            companyId: "company-1",
            rootIssueId: "issue-root",
          },
        },
      },
    });
  });
});


describe("paused hire request", () => {
  it("emits an inert process request even if the editor previously held a configured provider", () => {
    const payload = buildNewAgentHirePayload({
      name: " CFO ", effectiveRole: "general", title: "Chief Financial Officer",
      reportsTo: "22222222-2222-4222-8222-222222222222", pausedSetup: true, idempotencyKey: "same-attempt",
      configValues: { ...defaultCreateValues, adapterType: "claude_local", heartbeatEnabled: true },
      adapterConfig: { command: "must-not-launch", env: { TOKEN: "SENTINEL_DO_NOT_TRANSMIT" } },
      selectedSkillKeys: ["must-not-install"], permissions: { canCreateAgents: true, canCreateSkills: true },
    });
    expect(payload).toMatchObject({ name: "CFO", pausedSetup: true, idempotencyKey: "same-attempt", adapterType: "process", adapterConfig: {}, defaultEnvironmentId: null, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, wakeOnAssignment: false, wakeOnAutomation: false, intervalSec: 0 } }, permissions: { canCreateAgents: false, canCreateSkills: false, canAssignTasks: false } });
    expect(payload).not.toHaveProperty("desiredSkills");
    expect(JSON.stringify(payload)).not.toContain("SENTINEL");
    expect(JSON.stringify(payload)).not.toContain("must-not");
  });
});
