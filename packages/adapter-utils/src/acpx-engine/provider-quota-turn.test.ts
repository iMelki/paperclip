import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";
import {
  ACPX_PROVIDER_QUOTA_ERROR_CODE,
  classifyAcpxProviderQuotaTurn,
} from "./provider-quota.js";

const tempRoots: string[] = [];
const REAL_SESSION_LIMIT =
  "Internal error: You've hit your session limit — resets 10:40pm (Asia/Jerusalem)";

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-quota-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function turnRuntime(input: {
  events: () => AsyncGenerator<Record<string, unknown>>;
  result: Promise<Record<string, unknown>>;
}) {
  return {
    ensureSession: async () => ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
    }),
    startTurn: () => ({
      events: input.events(),
      result: input.result,
      cancel: async () => {},
    }),
    close: async () => {},
  };
}

async function runTurn(input: {
  events: () => AsyncGenerator<Record<string, unknown>>;
  result: Promise<Record<string, unknown>>;
}) {
  const root = await makeTempRoot();
  const execute = createAcpxEngineExecutor({
    createRuntime: () => turnRuntime(input) as never,
  });
  return execute({
    runId: "run-quota",
    agent: { id: "agent-1", companyId: "company-1" },
    runtime: {},
    config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
  } as never);
}

it("maps a failed ACPX terminal with the real session-limit message to the quota code", async () => {
  const result = await runTurn({
    events: async function* () {
      yield { type: "done", stopReason: "failed" };
    },
    result: Promise.resolve({ status: "failed", error: new Error(REAL_SESSION_LIMIT) }),
  });
  const expected = classifyAcpxProviderQuotaTurn(REAL_SESSION_LIMIT);
  expect(result.errorCode).toBe(ACPX_PROVIDER_QUOTA_ERROR_CODE);
  expect(result.quotaResetAt).toBe(expected?.quotaResetAt ?? null);
  expect(result.retryNotBefore).toBe(expected?.quotaResetAt ?? null);
  expect((result.resultJson as Record<string, unknown>).quotaResetAt).toBe(expected?.quotaResetAt ?? null);
  expect(result.quotaResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

it("maps a usage-limit turn failure and leaves an unparseable reset null", async () => {
  const usageLimit = "You've hit your usage limit · resets 9pm (UTC)";
  const usageError = Object.assign(new Error(usageLimit), { code: "ACP_TURN_FAILED" });
  const parsed = await runTurn({
    events: async function* () {
      throw usageError;
    },
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
  });
  const expected = classifyAcpxProviderQuotaTurn(usageLimit);
  expect(parsed.errorCode).toBe(ACPX_PROVIDER_QUOTA_ERROR_CODE);
  expect(parsed.quotaResetAt).toBe(expected?.quotaResetAt ?? null);
  expect((parsed.resultJson as Record<string, unknown>).phase).toBe("turn");
  expect(parsed.quotaResetAt).not.toBeNull();

  const unparsed = await runTurn({
    events: async function* () {
      throw Object.assign(new Error("usage limit exceeded"), { code: "ACP_TURN_FAILED" });
    },
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
  });
  expect(unparsed.errorCode).toBe(ACPX_PROVIDER_QUOTA_ERROR_CODE);
  expect(unparsed.quotaResetAt).toBeNull();
  expect((unparsed.resultJson as Record<string, unknown>).quotaResetAt).toBeNull();
});

it("leaves an unrelated failed turn on acpx_turn_failed", async () => {
  const result = await runTurn({
    events: async function* () {
      yield { type: "done", stopReason: "failed" };
    },
    result: Promise.resolve({
      status: "failed",
      error: new Error("The agent failed while reading a workspace file"),
    }),
  });
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(result.quotaResetAt).toBeUndefined();
  expect((result.resultJson as Record<string, unknown>).quotaResetAt).toBeUndefined();
});
