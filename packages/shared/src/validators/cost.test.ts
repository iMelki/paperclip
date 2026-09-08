import { describe, expect, it } from "vitest";
import { createCostEventSchema } from "./cost.js";

const base = {
  agentId: "a616ec6b-d5a4-43a9-9151-5376d5c69799", provider: "openai", model: "test-model",
  costCents: 10, occurredAt: "2026-09-01T12:00:00.000Z",
};

describe("cost source identity contract", () => {
  it("keeps legacy reports valid and normalizes complete source identities", () => {
    expect(createCostEventSchema.parse(base).biller).toBe("openai");
    expect(createCostEventSchema.parse({ ...base, sourceSystem: " export ", sourceAccountId: " acct ", sourceEventId: " event " }))
      .toMatchObject({ sourceSystem: "export", sourceAccountId: "acct", sourceEventId: "event" });
  });

  it("rejects a partial identity for the missing-scope reason, then accepts its repair", () => {
    const broken = { ...base, sourceEventId: "event" };
    expect(Object.hasOwn(broken, "sourceAccountId")).toBe(false);
    const rejected = createCostEventSchema.safeParse(broken);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues).toContainEqual(expect.objectContaining({
      path: ["sourceEventId"], message: "sourceSystem, sourceAccountId and sourceEventId must be supplied together",
    }));
    expect(createCostEventSchema.safeParse({ ...broken, sourceSystem: "export", sourceAccountId: "acct" }).success).toBe(true);
  });

  it("rejects blank source identifiers instead of conflating accounts", () => {
    const result = createCostEventSchema.safeParse({ ...base, sourceSystem: "export", sourceAccountId: " ", sourceEventId: "event" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "sourceAccountId")).toBe(true);
  });
});
