#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

let typedSessionFailureSupported = false;

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// PAPERCLIP_ACPX_TURN_SCRIPT is a JSON array of turns. A prompt containing
// "paperclip-turn:<n>" selects entry n (default 0), so the script survives agent restarts.
// Entry fields: severity ("error" | "warning" | absent for a plain success),
// usage (sent only in the prompt response), streamedUsage (sent first as a
// usage_update session notification).
function scriptedPromptTurn(request) {
  const script = JSON.parse(process.env.PAPERCLIP_ACPX_TURN_SCRIPT);
  const text = (request.params?.prompt ?? []).map((block) => block?.text ?? "").join("\n");
  const index = Number(/paperclip-turn:(\d+)/.exec(text)?.[1] ?? 0);
  const turn = script[index] ?? {};
  const sessionId = request.params.sessionId;
  if (turn.streamedUsage) {
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "usage_update", used: 1, size: 1000, _meta: { usage: turn.streamedUsage } } },
    });
  }
  writeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `scripted turn ${index}` } } },
  });
  const response = { stopReason: "end_turn", ...(turn.usage ? { usage: turn.usage } : {}) };
  if (turn.severity && typedSessionFailureSupported) {
    response._meta = { jetbrains: { air: {
      version: 1,
      sessionFailure: { version: 1, severity: turn.severity, category: "request", title: `scripted ${turn.severity} ${index}` },
    } } };
  }
  return response;
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    const meta = request.params?.clientCapabilities?._meta;
    const air = meta?.jetbrains?.air;
    typedSessionFailureSupported = air?.version === 1 && air.capabilities?.includes("sessionFailure");
    if (process.env.PAPERCLIP_ACPX_INITIALIZE_CANARY) {
      appendFileSync(process.env.PAPERCLIP_ACPX_INITIALIZE_CANARY, `${JSON.stringify(meta ?? null)}\n`);
    }
    process.stderr.write("Error handling request { method: 'nes/close' } { code: -32601 }\n");
    process.stderr.write("paperclip-acp-echo-agent started\n");
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-echo-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") return { sessionId: randomUUID() };
  if (request.method === "session/prompt") {
    if (process.env.PAPERCLIP_ACPX_TURN_SCRIPT) return scriptedPromptTurn(request);
    if (process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CANARY && typedSessionFailureSupported) {
      return {
        stopReason: "end_turn",
        _meta: { jetbrains: { air: {
          version: 1,
          sessionFailure: {
            version: 1,
            severity: process.env.PAPERCLIP_ACPX_TYPED_FAILURE_SEVERITY ?? "error",
            category: process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY ?? "request",
            title: process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CANARY,
          },
        } } },
      };
    }
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: process.env.PAPERCLIP_ACPX_SPAWN_SMOKE ?? "missing" },
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});
