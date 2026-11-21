import { describe, expect, it } from "vitest";
import { createAgentHireSchema } from "./agent.js";

const hire = { name: "Engineer", adapterType: "process" };

describe("hire idempotency key validation", () => {
  it("retains and trims an optional body key", () => {
    const parsed = createAgentHireSchema.parse({ ...hire, idempotencyKey: " hire:plan:revision:1 " });
    expect(parsed.idempotencyKey).toBe("hire:plan:revision:1");
  });

  it.each(["", " ", "x".repeat(256), "two words", "line\nbreak", "non-ascii-\u2603", null, 1])(
    "rejects invalid body key %j",
    (idempotencyKey) => {
      const parsed = createAgentHireSchema.safeParse({ ...hire, idempotencyKey });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(["idempotencyKey"]);
    },
  );

  it("keeps the no-key create defaults unchanged", () => {
    const parsed = createAgentHireSchema.parse(hire);
    expect(parsed.idempotencyKey).toBeUndefined();
    expect(parsed.role).toBe("general");
    expect(parsed.adapterConfig).toEqual({});
    expect(parsed.runtimeConfig).toEqual({});
    expect(parsed.budgetMonthlyCents).toBe(0);
  });
});
