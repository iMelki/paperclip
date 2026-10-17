import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const providerTitle = "Synthetic provider request rejected";
const agentCommand = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`;

async function runFixture(mode: "oneshot" | "persistent", severity: "error" | "warning") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-typed-failure-"));
  const initializePath = path.join(root, "initialize.jsonl");
  const result = await createAcpxEngineExecutor()({
    runId: `typed-${mode}-${severity}`,
    agent: { id: "typed-agent", companyId: "typed-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand,
      mode,
      warmHandleIdleMs: 0,
      stateDir: path.join(root, "state"),
      cwd: root,
      env: {
        PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: providerTitle,
        PAPERCLIP_ACPX_TYPED_FAILURE_SEVERITY: severity,
        PAPERCLIP_ACPX_INITIALIZE_CANARY: initializePath,
      },
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
  } as never);
  const meta = (await fs.readFile(initializePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { result, meta };
}

it.each(["startTurn", "runTurn"] as const)("%s: binds complete diagnostics to the current turn", async (method) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-typed-callback-"));
  const title = `${"x".repeat(4_100)} diagnostic-tail`;
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: root }),
    agentRegistry: createAgentRegistry({ overrides: { custom: agentCommand } }),
    permissionMode: "approve-all",
    onAgentStderr: () => {},
  });
  const handle = await runtime.ensureSession({
    sessionKey: `callback-${method}`, agent: "custom", mode: "persistent", cwd: root,
    sessionOptions: { env: { PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: title } },
  });
  const failures: unknown[][] = [[], []];
  try {
    for (const index of [0, 1]) {
      const input = {
        handle, text: "typed failure", mode: "prompt" as const, requestId: `callback-${index}`,
        onTerminalSessionFailure: (failure: unknown) => { failures[index].push(failure); },
      };
      if (method === "startTurn") {
        const turn = runtime.startTurn(input);
        for await (const _event of turn.events) { /* Drain before reading the terminal result. */ }
        expect((await turn.result).status).toBe("failed");
      } else {
        for await (const _event of runtime.runTurn(input)) { /* Drain the real ACP turn. */ }
      }
      expect(failures[index]).toEqual([{ category: "request", title }]);
      expect(failures[0]).toHaveLength(1);
    }
  } finally {
    await runtime.close({ handle, reason: "typed-failure callback test complete" });
  }
}, 30_000);

for (const mode of ["oneshot", "persistent"] as const) {
  it(`${mode}: fails a negotiated typed terminal error despite end_turn`, async () => {
    const { result } = await runFixture(mode, "error");
    // Keep the observed fields in negative-proof output without printing host paths.
    console.log(JSON.stringify({ mode, exitCode: result.exitCode, errorCode: result.errorCode,
      stopReason: result.resultJson?.stopReason }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_turn_failed");
    expect(result.resultJson?.stopReason).toBe("ACP agent reported a terminal request failure.");
    expect(result.errorMessage).not.toContain(providerTitle);
  }, 30_000);

  it(`${mode}: advertises sessionFailure in initialize clientCapabilities._meta`, async () => {
    const { meta } = await runFixture(mode, "warning");
    console.log(JSON.stringify({ mode, initializeMeta: meta }));
    expect(meta.length).toBeGreaterThan(0);
    for (const value of meta) {
      expect(value?.jetbrains?.air?.version).toBe(1);
      expect(value?.jetbrains?.air?.capabilities).toContain("sessionFailure");
    }
  }, 30_000);

  it(`${mode}: keeps an error-shaped warning successful`, async () => {
    const { result } = await runFixture(mode, "warning");
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.resultJson?.stopReason).toBe("end_turn");
  }, 30_000);
}
