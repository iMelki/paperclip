import { describe, expect, it } from "vitest";

import { defaultCreateValues } from "./agent-config-defaults";

describe("defaultCreateValues", () => {
  it("requires an explicit opt-in before new agents bypass permission prompts", () => {
    expect(defaultCreateValues.dangerouslySkipPermissions).toBe(false);
    expect(defaultCreateValues.dangerouslyBypassSandbox).toBe(false);
  });

  it("gives new Codex agents structured workspace controls without ignoring their curated home", () => {
    expect(defaultCreateValues.codexSandboxMode).toBe("workspace-write");
    expect(defaultCreateValues.codexApprovalPolicy).toBe("never");
    expect(defaultCreateValues.codexNetworkAccess).toBe(false);
    expect(defaultCreateValues.codexIgnoreUserConfig).toBe(false);
    expect(defaultCreateValues.codexConfigProfile).toBe("");
  });
});
