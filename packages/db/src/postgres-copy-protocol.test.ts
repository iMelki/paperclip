import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import postgres from "postgres";

function backendMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

const READY_FOR_QUERY = backendMessage("Z", Buffer.from("I"));
const COPY_IN_RESPONSE = backendMessage("G", Buffer.from([0, 0, 0]));
const COPY_BOTH_RESPONSE = backendMessage("W", Buffer.from([0, 0, 0]));
const COMMAND_COMPLETE = backendMessage("C", Buffer.from("SELECT 1\0"));
const CHECK_VIOLATION = backendMessage("E", Buffer.from([
  ...Buffer.from("VERROR\0C23514\0Msynthetic check violation\0"),
  0,
]));

class ScriptedPostgresSocket extends EventEmitter {
  readyState = "open";
  copyDoneCount = 0;
  copyFailCount = 0;

  private send(response: Buffer, readyForQuery = false): void {
    setImmediate(() => {
      this.emit("data", response);
      if (readyForQuery) this.emit("ready-for-query");
    });
  }

  rejectCopyBeforeDone(): Promise<void> {
    const ready = new Promise<void>((resolve) => this.once("ready-for-query", resolve));
    this.send(Buffer.concat([CHECK_VIOLATION, READY_FOR_QUERY]), true);
    return ready;
  }

  write(value: Buffer, callback?: (error?: Error | null) => void): boolean {
    const message = Buffer.from(value);
    if (message[0] === 0) {
      this.send(Buffer.concat([
        backendMessage("R", Buffer.from([0, 0, 0, 0])),
        READY_FOR_QUERY,
      ]), true);
    } else if (message[0] === "Q".charCodeAt(0)) {
      const query = message.toString("utf8");
      const response = query.includes("COPY_BOTH")
        ? COPY_BOTH_RESPONSE
        : query.includes("COPY")
          ? COPY_IN_RESPONSE
          : Buffer.concat([COMMAND_COMPLETE, READY_FOR_QUERY]);
      this.send(response, !query.includes("COPY") && !query.includes("COPY_BOTH"));
    } else if (message[0] === "c".charCodeAt(0)) {
      this.copyDoneCount += 1;
      this.send(Buffer.concat([CHECK_VIOLATION, READY_FOR_QUERY]), true);
    } else if (message[0] === "f".charCodeAt(0)) {
      this.copyFailCount += 1;
      this.send(Buffer.concat([CHECK_VIOLATION, READY_FOR_QUERY]), true);
    }

    callback?.();
    return true;
  }

  pause(): void {}
  resume(): void {}

  end(): void {
    this.readyState = "closed";
    setImmediate(() => this.emit("close"));
  }
}

function createSql(socket: ScriptedPostgresSocket) {
  return postgres("postgres://paperclip:paperclip@127.0.0.1:5432/test", {
    socket: () => socket,
    fetch_types: false,
    max: 1,
    idle_timeout: 0,
  } as never);
}

describe("postgres.js COPY error protocol", () => {
  it("rejects a server error after CopyDone without sending late CopyFail and keeps the connection reusable", async () => {
    const socket = new ScriptedPostgresSocket();
    const sql = createSql(socket);

    try {
      const sink = await sql.unsafe("COPY copy_test FROM STDIN;").writable();
      await expect(pipeline(Readable.from(["-1\n"], { objectMode: false }), sink))
        .rejects.toThrow("synthetic check violation");

      expect(socket.copyDoneCount).toBe(1);
      expect(socket.copyFailCount).toBe(0);
      await sql.unsafe("SELECT 1;").simple().execute();
    } finally {
      await sql.end();
    }
  }, 10_000);

  it("sends exactly one CopyFail for a client-side failure before CopyDone", async () => {
    const socket = new ScriptedPostgresSocket();
    const sql = createSql(socket);

    try {
      const sink = await sql.unsafe("COPY copy_test FROM STDIN;").writable();
      sink.on("error", () => {});
      const ready = new Promise<void>((resolve) => socket.once("ready-for-query", resolve));
      sink.destroy(new Error("synthetic source failure"));
      await ready;

      expect(socket.copyDoneCount).toBe(0);
      expect(socket.copyFailCount).toBe(1);
      await sql.unsafe("SELECT 1;").simple().execute();
    } finally {
      await sql.end();
    }
  }, 10_000);

  it("does not send CopyFail after a server rejection before CopyDone", async () => {
    const socket = new ScriptedPostgresSocket();
    const sql = createSql(socket);

    try {
      const sink = await sql.unsafe("COPY copy_test FROM STDIN;").writable();
      sink.on("error", () => {});
      await socket.rejectCopyBeforeDone();

      expect(socket.copyDoneCount).toBe(0);
      expect(socket.copyFailCount).toBe(0);
      await sql.unsafe("SELECT 1;").simple().execute();
    } finally {
      await sql.end();
    }
  }, 10_000);

  it("settles CopyBoth final once and does not send CopyFail after CopyDone", async () => {
    const socket = new ScriptedPostgresSocket();
    const sql = createSql(socket);

    try {
      const stream = await sql.unsafe("COPY_BOTH").writable();
      let streamErrors = 0;
      stream.on("error", () => {
        streamErrors += 1;
      });
      await expect(pipeline(Readable.from([]), stream))
        .rejects.toThrow("synthetic check violation");

      expect(socket.copyDoneCount).toBe(1);
      expect(socket.copyFailCount).toBe(0);
      expect(streamErrors).toBe(1);
      await sql.unsafe("SELECT 1;").simple().execute();
    } finally {
      await sql.end();
    }
  }, 10_000);
});
