import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost, type WorkerRpcHost } from "../src/worker-rpc-host.js";

const manifest = {
  id: "test.http-scope",
  apiVersion: 1 as const,
  version: "1.0.0",
  displayName: "HTTP scope test",
  description: "HTTP scope test",
  author: "Paperclip",
  categories: ["automation" as const],
  capabilities: ["http.outbound" as const],
  entrypoints: { worker: "./dist/worker.js" },
};

function createRpcTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messages: Array<JsonRpcRequest | JsonRpcResponse> = [];
  const waiters = new Set<() => void>();
  let buffer = "";

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
      for (const wake of waiters) wake();
      waiters.clear();
    }
  });

  const send = (message: unknown) => {
    stdin.write(`${JSON.stringify(message)}\n`);
  };

  const next = async (
    predicate: (message: JsonRpcRequest | JsonRpcResponse) => boolean,
  ): Promise<JsonRpcRequest | JsonRpcResponse> => {
    for (;;) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  };

  return { stdin, stdout, send, next };
}

describe("worker RPC host scoped HTTP serialization", () => {
  let worker: WorkerRpcHost | null = null;

  afterEach(() => {
    worker?.stop();
    worker = null;
  });

  it("serializes the explicit company scope and echoes the host invocation id", async () => {
    const transport = createRpcTransport();
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("callback", async (_params, context) => {
          const response = await ctx.http.fetch(
            "http://127.0.0.1:3021/api/callbacks/run-1",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"ok":true}',
            },
            { companyId: context.companyId ?? undefined },
          );
          return { status: response.status };
        });
      },
    });
    worker = startWorkerRpcHost({
      plugin,
      stdin: transport.stdin,
      stdout: transport.stdout,
      rpcTimeoutMs: 2_000,
    });

    transport.send({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        manifest,
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
      },
    });
    await transport.next((message) => message.id === "initialize-1");

    transport.send({
      jsonrpc: "2.0",
      id: "action-1",
      method: "performAction",
      paperclipInvocation: {
        id: "invocation-1",
        scope: { companyId: "company-1" },
      },
      params: {
        key: "callback",
        companyId: "company-1",
        params: {},
        actorContext: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: "company-1",
        },
      },
    });

    const fetchRequest = await transport.next(
      (message) => "method" in message && message.method === "http.fetch",
    ) as JsonRpcRequest;
    expect(fetchRequest.paperclipInvocationId).toBe("invocation-1");
    expect(fetchRequest.params).toEqual({
      url: "http://127.0.0.1:3021/api/callbacks/run-1",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
      companyId: "company-1",
    });

    transport.send({
      jsonrpc: "2.0",
      id: fetchRequest.id,
      result: {
        status: 202,
        statusText: "Accepted",
        headers: { "content-type": "application/json" },
        body: '{"accepted":true}',
      },
    });

    await expect(transport.next((message) => message.id === "action-1")).resolves.toMatchObject({
      result: { status: 202 },
    });
  });
});
