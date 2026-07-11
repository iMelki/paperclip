import { describe, expect, it } from "vitest";

import { defaultCreateValues } from "./agent-config-defaults";

describe("defaultCreateValues", () => {
  it("requires an explicit opt-in before new agents bypass permission prompts", () => {
    expect(defaultCreateValues.dangerouslySkipPermissions).toBe(false);
  });
});
