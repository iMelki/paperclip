import { describe, expect, it, vi } from "vitest";
import type { HostServices } from "../src/host-client-factory.js";
import { createHostClientHandlers, InvocationScopeDeniedError, CapabilityDeniedError } from "../src/host-client-factory.js";

const user = { invocationScope: { companyId: "company-a", actor: { type: "user" as const, userId: "operator" } } };
function fixture(capabilities: ("issues.read" | "issues.create" | "issues.update" | "projects.read")[] =
  ["issues.read", "issues.create", "issues.update", "projects.read"]) {
  const call = vi.fn(async () => ({ verified: true }));
  const handlers = createHostClientHandlers({ pluginId: "test.plugin", capabilities,
    services: { issues: { importedBoard: call } } as unknown as HostServices });
  return { call, run: handlers["issues.importedBoard"] };
}

describe("native imported-board boundary", () => {
  it("passes the host-owned user context, not a request actor", async () => {
    const { run, call } = fixture();
    const request = { companyId: "company-a", op: "begin" as const, intent: {} };
    await run(request, user);
    expect(call).toHaveBeenCalledWith(request, user);
  });
  it.each([undefined, { invocationScope: { companyId: "company-a" } },
    { invocationScope: { companyId: "company-a", actor: { type: "agent" as const, userId: "operator" } } },
    { invocationScope: { companyId: "company-a", actor: { type: "user" as const, userId: null } } },
    { ...user, invalidInvocationScope: true },
    { invocationScope: { companyId: "company-b", actor: user.invocationScope.actor } },
  ])("rejects absent, forged, expired or foreign invocation context %#", async context => {
    const { run, call } = fixture();
    await expect(run({ companyId: "company-a", op: "commit", intent: {} }, context)).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([
    { capabilities: [], missing: "issues.read" },
    { capabilities: ["issues.read", "projects.read"], missing: "issues.create" },
    { capabilities: ["issues.read", "projects.read", "issues.create"], missing: "issues.update" },
    { capabilities: ["issues.read", "projects.read", "issues.update"], missing: "issues.create" },
    { capabilities: ["issues.read", "issues.create", "issues.update"], missing: "projects.read" },
  ] as const)(
    "rejects incomplete mutation capabilities %#", async ({ capabilities, missing }) => {
      const { run, call } = fixture([...capabilities]);
      await expect(run({ companyId: "company-a", op: "begin", intent: {} }, user)).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(run({ companyId: "company-a", op: "begin", intent: {} }, user)).rejects.toThrow(`missing required capability "${missing}"`);
      expect(call).not.toHaveBeenCalled();
    });
  it("allows read-only stock exclusions in a company-scoped job", async () => {
    const { run, call } = fixture(["issues.read"]);
    await run({ companyId: "company-a", op: "sources" }, { invocationScope: { companyId: "company-a" } });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(["listProjectConnections", "readProjectBinding", "bindProjectBoard", "readProjectPage"] as const)
    ("requires project capability before native OAuth operation %s", async op => {
      const { run, call } = fixture(["issues.read"]);
      const scope = { companyId: "company-a", projectId: "11111111-1111-4111-8111-111111111111" };
      const request = op === "bindProjectBoard" ? { ...scope, op, boardUrl: "https://github.com/users/example/projects/12",
        connectionId: "22222222-2222-4222-8222-222222222222" }
        : op === "readProjectPage" ? { ...scope, op, page: { ownerType: "user" as const, owner: "example",
          number: 12, after: null, first: 50 } } : { ...scope, op };
      await expect(run(request, user)).rejects.toThrow('missing required capability "projects.read"');
      expect(call).not.toHaveBeenCalled();
    });
  it("does not allow an unscoped job to select a company", async () => {
    const { run, call } = fixture(["issues.read"]);
    await expect(run({ companyId: "company-a", op: "sources" })).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(call).not.toHaveBeenCalled();
  });
  it("does not emulate an absent host service", async () => {
    const handlers = createHostClientHandlers({ pluginId: "test.plugin", capabilities: ["issues.read"],
      services: { issues: {} } as unknown as HostServices });
    await expect(handlers["issues.importedBoard"]({ companyId: "company-a", op: "capabilities" }, user))
      .rejects.toThrow("does not implement atomic board imports");
  });
});
