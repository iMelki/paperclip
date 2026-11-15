import { describe, expect, it } from "vitest";

import { CONFIG_DEFERRED_PROVIDERS, VALID_PROVIDERS } from "./constants.js";

describe("Hermes provider constants", () => {
  it("lists every provider once and keeps auto and custom selectable", () => {
    expect(new Set(VALID_PROVIDERS).size).toBe(VALID_PROVIDERS.length);
    expect(VALID_PROVIDERS).toContain("auto");
    expect(VALID_PROVIDERS).toContain("custom");
  });

  it("only defers providers that are themselves in the list", () => {
    for (const provider of CONFIG_DEFERRED_PROVIDERS) expect(VALID_PROVIDERS).toContain(provider);
    expect(CONFIG_DEFERRED_PROVIDERS).toEqual(["custom"]);
  });
});
