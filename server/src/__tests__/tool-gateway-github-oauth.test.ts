import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, approvals, companies, createDb, heartbeatRuns, issues, toolActionRequests,
  toolApplications, toolCatalogEntries, toolConnections, toolInvocations,
  toolCallEvents, toolAccessAuditEvents, toolProfileBindings, toolProfiles,
} from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { githubOAuthToolDescriptors } from "../services/github-oauth-transport.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

const { nativeExecutor, syntheticDispatch } = vi.hoisted(() => ({ nativeExecutor: vi.fn(), syntheticDispatch: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({
  toolAccessService: () => ({ executeGitHubOAuthTool: nativeExecutor }),
}));

type Db = ReturnType<typeof createDb>;
type Gateway = ReturnType<typeof createToolGatewayService>;
const readName = "github_get_account";
const writeName = "github_create_issue";
const writeArgs = { owner: "synthetic-owner", repo: "synthetic-repo", title: "Synthetic reviewed issue" };
const signingSecret = "synthetic-github-gateway-action-signing-secret";

function nativeConfig() {
  return { sourceTemplateKey: "github", methodKey: "rest-oauth", serverUrl: "https://api.github.com",
    oauth: { provider: "github", authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token", providerAccountId: 12345 } };
}

async function createFixture(db: Db, allow = true) {
  const [company] = await db.insert(companies).values({ name: `Synthetic GH ${randomUUID()}`,
    issuePrefix: `GH${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Synthetic agent",
    role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic approval task",
    status: "in_progress", assigneeAgentId: agent.id }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
    invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
  const [application] = await db.insert(toolApplications).values({ companyId: company.id,
    applicationKey: `synthetic-github-${randomUUID()}`, name: "Synthetic GitHub", type: "rest_api",
    status: "active", metadata: { sourceTemplateKey: "github", galleryKey: "github" } }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
    name: "Synthetic GitHub", uid: `synthetic/${randomUUID()}`, transport: "rest_api", authKind: "oauth",
    status: "active", enabled: true, healthStatus: "ok", config: nativeConfig(), transportConfig: nativeConfig(),
    credentialRefs: [], credentialSecretRefs: [] }).returning();
  const catalog = await db.insert(toolCatalogEntries).values(githubOAuthToolDescriptors().map(descriptor => ({
    companyId: company.id, applicationId: application.id, connectionId: connection.id,
    entryKind: "tool" as const, name: descriptor.name, toolName: descriptor.name, title: descriptor.name,
    description: descriptor.description, inputSchema: descriptor.inputSchema, annotations: descriptor.annotations,
    riskLevel: descriptor.risk, isReadOnly: descriptor.risk === "read", isWrite: descriptor.risk === "write",
    isDestructive: false, status: "active" as const, versionHash: randomUUID(), schemaHash: randomUUID(),
  }))).returning();
  if (allow) {
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id,
      profileKey: `synthetic-${randomUUID()}`, name: "Synthetic permissive profile", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id,
      targetType: "agent", targetId: agent.id });
  }
  const gateway = createToolGatewayService(db, { toolActionSigningSecret: signingSecret });
  return { company, agent, issue, run, application, connection, catalog, gateway };
}

async function parkedWrite(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const result = await fixture.gateway.executeTestCall({ companyId: fixture.company.id,
    connectionId: fixture.connection.id, agentId: fixture.agent.id, userId: "synthetic-board-user",
    toolName: writeName, parameters: writeArgs });
  expect(result.decision).toBe("ask_first");
  if (result.decision !== "ask_first") throw new Error("Synthetic GitHub write did not park for approval");
  const [request] = await db.select().from(toolActionRequests)
    .where(eq(toolActionRequests.id, result.actionRequestId!));
  return request;
}

async function approveFormal(fixture: Awaited<ReturnType<typeof createFixture>>, approvalId: string) {
  await db.update(approvals).set({ status: "approved", decidedByUserId: "synthetic-board-user",
    decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, fixture.company.id)));
}

async function nativeTool(gateway: Gateway, sessionToken: string, toolName: string) {
  const tool = (await gateway.listToolsForSession(sessionToken)).find(candidate => candidate.upstreamToolName === toolName);
  expect(tool?.providerType).toBe("github_rest");
  return tool!;
}

let db!: Db;
describe("native GitHub gateway boundary (mandatory isolated PostgreSQL)", () => {
  let fixtureDb: Awaited<ReturnType<typeof startBoardImportFixtureDatabase>> | null = null;
  beforeAll(async () => {
    fixtureDb = await startBoardImportFixtureDatabase();
    db = createDb(fixtureDb.connectionString);
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await fixtureDb?.cleanup();
  }, 25_000);
  beforeEach(() => {
    nativeExecutor.mockReset();
    syntheticDispatch.mockReset();
    nativeExecutor.mockImplementation(async input => {
      await input.beforeDispatch();
      syntheticDispatch(input);
      return { content: [{ type: "text", text: JSON.stringify({
      synthetic: true, toolName: input.toolName, parameters: input.parameters }) }],
      structuredContent: { synthetic: true }, isError: false };
    });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Native gateway fixture must not call a provider"); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("does not grant agent tools merely because a native connection is active", async () => {
    const fixture = await createFixture(db, false);
    const summary = await fixture.gateway.summarizeConnectionAccessForAgent({ companyId: fixture.company.id,
      connectionId: fixture.connection.id, agentId: fixture.agent.id });
    expect(summary.allowedCount).toBe(0);
    expect(summary.askFirstCount).toBe(0);
    expect(summary.offCount).toBe(githubOAuthToolDescriptors().length);
    expect(nativeExecutor).not.toHaveBeenCalled();
  });

  it("dispatches an allowed read through the internal executor with authoritative IDs, not a bearer", async () => {
    const fixture = await createFixture(db);
    const result = await fixture.gateway.executeTestCall({ companyId: fixture.company.id,
      connectionId: fixture.connection.id, agentId: fixture.agent.id, userId: "synthetic-board-user",
      toolName: readName, parameters: {}, timeoutMs: 5000 });
    expect(result.decision).toBe("allowed");
    expect(nativeExecutor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: fixture.company.id,
      connectionId: fixture.connection.id, toolName: readName, parameters: {}, timeoutMs: 5000,
      actor: { actorType: "user", actorId: "synthetic-board-user" } }));
    const input = nativeExecutor.mock.calls[0]![0];
    expect(input.catalogEntryId).toBe(fixture.catalog.find(entry => entry.toolName === readName)!.id);
    expect(Object.keys(input)).not.toContain("accessToken");
    expect(input.runContext).toEqual({ runId: null, issueId: null });
    expect(input.beforeDispatch).toEqual(expect.any(Function));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("dispatches an allowed agent read without creating another synthetic run", async () => {
    const fixture = await createFixture(db);
    const session = await fixture.gateway.createSession({ companyId: fixture.company.id,
      agentId: fixture.agent.id, runId: fixture.run.id });
    const tool = await nativeTool(fixture.gateway, session.token, readName);
    const before = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.company.id));
    await fixture.gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(nativeExecutor.mock.calls[0]![0].actor).toEqual({ actorType: "agent", actorId: fixture.agent.id });
    expect(nativeExecutor.mock.calls[0]![0].runContext).toEqual({ runId: fixture.run.id, issueId: fixture.issue.id });
    const after = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.company.id));
    expect(after).toEqual(before);
  });

  it("forces formal approval for a test-tab write even under an allow-all profile, then executes once", async () => {
    const fixture = await createFixture(db);
    const summary = await fixture.gateway.summarizeConnectionAccessForAgent({ companyId: fixture.company.id,
      connectionId: fixture.connection.id, agentId: fixture.agent.id });
    expect(summary.tools.find(tool => tool.toolName === writeName)?.decision).toBe("ask_first");
    const request = await parkedWrite(fixture);
    expect(request.approvalId).toEqual(expect.any(String));
    expect(nativeExecutor).not.toHaveBeenCalled();
    await expect(fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } })).rejects.toMatchObject({ reasonCode: "formal_approval_required" });
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(nativeExecutor.mock.calls[0]![0].parameters).toEqual(writeArgs);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "succeeded", approvalState: "approved" });
    const [approvedRequest] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request.id));
    expect(approvedRequest).toMatchObject({ id: request.id, invocationId: request.invocationId,
      approvalId: request.approvalId, status: "approved" });
    const repeated = await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(repeated).toEqual(approvedRequest);
    const [requestAfterRepeat] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request.id));
    expect(requestAfterRepeat).toEqual(approvedRequest);
    const [invocationAfterRepeat] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocationAfterRepeat).toEqual(invocation);
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(syntheticDispatch).toHaveBeenCalledTimes(1);
  });

  it("forces formal approval on the normal agent path and executes the stored reviewed arguments once", async () => {
    const fixture = await createFixture(db);
    const session = await fixture.gateway.createSession({ companyId: fixture.company.id,
      agentId: fixture.agent.id, runId: fixture.run.id });
    const tool = await nativeTool(fixture.gateway, session.token, writeName);
    await expect(fixture.gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: writeArgs }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, fixture.company.id));
    expect(nativeExecutor).not.toHaveBeenCalled();
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(nativeExecutor.mock.calls[0]![0]).toMatchObject({ parameters: writeArgs, timeoutMs: 30_000,
      actor: { actorType: "agent", actorId: fixture.agent.id } });
    await fixture.gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: writeArgs });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
  });

  it("holds a test-tab approved write if connection/account configuration changed after review", async () => {
    const fixture = await createFixture(db);
    const request = await parkedWrite(fixture);
    const changed = nativeConfig(); changed.oauth.providerAccountId = 99999;
    await db.update(toolConnections).set({ config: changed, transportConfig: changed }).where(eq(toolConnections.id, fixture.connection.id));
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(nativeExecutor).not.toHaveBeenCalled();
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "approved_tool_target_changed" });
  });

  it("holds an approved write if its signed arguments hash was replaced", async () => {
    const fixture = await createFixture(db);
    const request = await parkedWrite(fixture);
    await db.update(toolActionRequests).set({ canonicalArgumentsHash: "0".repeat(64) }).where(eq(toolActionRequests.id, request.id));
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(nativeExecutor).not.toHaveBeenCalled();
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "signed_arguments_mismatch" });
  });

  it.each(["expired", "no-human-decision"])("holds an approved native write with %s", async failure => {
    const fixture = await createFixture(db);
    const request = await parkedWrite(fixture);
    await approveFormal(fixture, request.approvalId!);
    if (failure === "expired") await db.update(toolActionRequests).set({ expiresAt: new Date(0) })
      .where(eq(toolActionRequests.id, request.id));
    if (failure === "no-human-decision") await db.update(approvals).set({ decidedByUserId: null })
      .where(eq(approvals.id, request.approvalId!));
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(nativeExecutor).not.toHaveBeenCalled();
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "formal_approval_required" });
  });

  it("checks the server-owned callback after preparation before even an allowed read can dispatch", async () => {
    const fixture = await createFixture(db);
    nativeExecutor.mockImplementationOnce(async input => {
      const changed = nativeConfig(); changed.oauth.providerAccountId = 99999;
      await db.update(toolConnections).set({ config: changed, transportConfig: changed })
        .where(eq(toolConnections.id, fixture.connection.id));
      await input.beforeDispatch();
      syntheticDispatch(input);
      return { content: [], structuredContent: {}, isError: false };
    });
    const result = await fixture.gateway.executeTestCall({ companyId: fixture.company.id,
      connectionId: fixture.connection.id, agentId: fixture.agent.id, userId: "synthetic-board-user",
      toolName: readName, parameters: {} });
    expect(result).toMatchObject({ error: { reasonCode: "approved_tool_target_changed" } });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(syntheticDispatch).not.toHaveBeenCalled();
  });

  it("retains safe unknown-write evidence without reporting test execution success or leaking provider payload", async () => {
    const fixture = await createFixture(db);
    const request = await parkedWrite(fixture);
    nativeExecutor.mockImplementationOnce(async input => {
      await input.beforeDispatch(); syntheticDispatch(input);
      throw new HttpError(504, "SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD", { code: "github_write_outcome_unknown",
        dispatched: true, outcomeUnknown: true, providerPayload: "SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD" });
    });
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "github_write_outcome_unknown", resultSummary: null });
    expect(invocation.errorMessage).toContain("Verify the target before retrying");
    const events = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, request.invocationId));
    expect(events.some(event => event.eventType === "call_completed" && event.outcome === "success")).toBe(false);
    expect(events.find(event => event.eventType === "call_failed")?.metadata).toMatchObject({
      nativeGitHub: { code: "github_write_outcome_unknown", dispatched: true, outcomeUnknown: true, httpStatus: 504 },
    });
    const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, fixture.company.id));
    expect(JSON.stringify([invocation, events, audits])).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD");
    expect(syntheticDispatch).toHaveBeenCalledTimes(1);
    const [approvedRequest] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request.id));
    expect(approvedRequest).toMatchObject({ id: request.id, invocationId: request.invocationId,
      approvalId: request.approvalId, status: "approved" });
    const repeated = await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    expect(repeated).toEqual(approvedRequest);
    const [requestAfterRepeat] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request.id));
    expect(requestAfterRepeat).toEqual(approvedRequest);
    const [invocationAfterRepeat] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocationAfterRepeat).toEqual(invocation);
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(syntheticDispatch).toHaveBeenCalledTimes(1);
  });

  it("does not turn an agent's unknown write into a successful replay or automatically dispatch it again", async () => {
    const fixture = await createFixture(db);
    const session = await fixture.gateway.createSession({ companyId: fixture.company.id,
      agentId: fixture.agent.id, runId: fixture.run.id });
    const tool = await nativeTool(fixture.gateway, session.token, writeName);
    await expect(fixture.gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: writeArgs }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, fixture.company.id));
    nativeExecutor.mockImplementationOnce(async input => {
      await input.beforeDispatch(); syntheticDispatch(input);
      throw new HttpError(504, "synthetic timeout", { code: "github_write_outcome_unknown", dispatched: true, outcomeUnknown: true });
    });
    await approveFormal(fixture, request.approvalId!);
    await fixture.gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: request.id,
      actor: { userId: "synthetic-board-user" } });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "github_write_outcome_unknown", resultSummary: null });
    await expect(fixture.gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: writeArgs }))
      .rejects.toMatchObject({ reasonCode: "github_write_outcome_unknown", details: { dispatched: true, outcomeUnknown: true } });
    expect(nativeExecutor).toHaveBeenCalledTimes(1);
    expect(syntheticDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["generic-source", "wrong-method", "foreign-endpoint", "transport-disagreement", "disabled", "unhealthy"])
    ("does not expose a REST connection with %s", async failure => {
      const fixture = await createFixture(db);
      const config = nativeConfig(); const transportConfig = nativeConfig();
      if (failure === "generic-source") config.sourceTemplateKey = "oauth-generic";
      if (failure === "wrong-method") config.methodKey = "mcp-key";
      if (failure === "foreign-endpoint") config.serverUrl = "https://api.github.com.evil.test";
      if (failure === "transport-disagreement") transportConfig.oauth.tokenUrl = "https://evil.example.test/token";
      await db.update(toolConnections).set({ config, transportConfig,
        ...(failure === "disabled" ? { enabled: false } : {}),
        ...(failure === "unhealthy" ? { healthStatus: "error" as const } : {}),
      }).where(eq(toolConnections.id, fixture.connection.id));
      const summary = await fixture.gateway.summarizeConnectionAccessForAgent({ companyId: fixture.company.id,
        connectionId: fixture.connection.id, agentId: fixture.agent.id });
      expect(summary.toolCount).toBe(0);
      expect(nativeExecutor).not.toHaveBeenCalled();
    });

  it.each(["quarantine", "read-spoof", "schema-spoof", "annotation-spoof", "unknown-tool", "foreign-application"])
    ("does not expose a native catalog entry with %s", async failure => {
      const fixture = await createFixture(db);
      const entry = fixture.catalog.find(row => row.toolName === writeName)!;
      const changes = failure === "quarantine" ? { quarantinedAt: new Date() }
        : failure === "read-spoof" ? { riskLevel: "read" as const, isReadOnly: true, isWrite: false }
        : failure === "schema-spoof" ? { inputSchema: { type: "object", additionalProperties: true } }
        : failure === "annotation-spoof" ? { annotations: { readOnlyHint: true } }
        : failure === "unknown-tool" ? { toolName: "github_arbitrary_graphql" }
        : { applicationId: null };
      await db.update(toolCatalogEntries).set(changes).where(eq(toolCatalogEntries.id, entry.id));
      const summary = await fixture.gateway.summarizeConnectionAccessForAgent({ companyId: fixture.company.id,
        connectionId: fixture.connection.id, agentId: fixture.agent.id });
      expect(summary.tools.some(tool => tool.toolName === writeName || tool.toolName === "github_arbitrary_graphql")).toBe(false);
      expect(nativeExecutor).not.toHaveBeenCalled();
    });

  it("does not resolve another company's connection or agent", async () => {
    const fixture = await createFixture(db);
    const other = await createFixture(db);
    await expect(fixture.gateway.executeTestCall({ companyId: other.company.id, connectionId: fixture.connection.id,
      agentId: fixture.agent.id, userId: "synthetic-board-user", toolName: readName, parameters: {} }))
      .rejects.toMatchObject({ reasonCode: "agent_not_found" });
    const summary = await fixture.gateway.summarizeConnectionAccessForAgent({ companyId: other.company.id,
      connectionId: fixture.connection.id, agentId: other.agent.id });
    expect(summary.toolCount).toBe(0);
    expect(nativeExecutor).not.toHaveBeenCalled();
  });
});
