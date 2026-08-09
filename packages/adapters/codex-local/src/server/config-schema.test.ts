import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("codex local config schema", () => {
  it("exposes structured execution controls with non-bypass defaults", () => {
    const fields = new Map(getConfigSchema().fields.map((field) => [field.key, field]));

    expect(fields.get("sandboxMode")).toMatchObject({
      type: "select",
      default: "workspace-write",
    });
    expect(fields.get("approvalPolicy")).toMatchObject({
      type: "select",
      default: "never",
    });
    expect(fields.get("networkAccess")).toMatchObject({
      type: "toggle",
      default: false,
    });
    expect(fields.get("ignoreUserConfig")).toMatchObject({
      type: "toggle",
      default: false,
    });
    expect(fields.get("configProfile")).toMatchObject({
      type: "text",
    });
  });
});
