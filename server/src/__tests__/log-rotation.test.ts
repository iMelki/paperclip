import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_MAX_FILES,
  DEFAULT_LOG_MAX_SIZE_MB,
  pruneLogArchives,
  resolveLogRotationOptions,
  rotateLogFileOnStartup,
  rotateOpenLogFile,
  startLogRotation,
} from "../middleware/log-rotation.js";

let dir: string;
let logFile: string;

function write(file: string, content: string) {
  fs.writeFileSync(file, content);
}

function names(): string[] {
  return fs.readdirSync(dir).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-rotation-"));
  logFile = path.join(dir, "server.log");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveLogRotationOptions", () => {
  it("defaults to 50 MB and 5 files", () => {
    expect(DEFAULT_LOG_MAX_SIZE_MB).toBe(50);
    expect(DEFAULT_LOG_MAX_FILES).toBe(5);
    expect(resolveLogRotationOptions({})).toEqual({ maxBytes: 50 * 1024 * 1024, maxFiles: 5 });
  });

  it("reads the env overrides and ignores invalid values", () => {
    expect(
      resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_SIZE_MB: "10", PAPERCLIP_LOG_MAX_FILES: "3" }),
    ).toEqual({ maxBytes: 10 * 1024 * 1024, maxFiles: 3 });
    expect(
      resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_SIZE_MB: "abc", PAPERCLIP_LOG_MAX_FILES: "0" }),
    ).toEqual({ maxBytes: 50 * 1024 * 1024, maxFiles: 5 });
    expect(resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_FILES: "2.5" }).maxFiles).toBe(5);
  });

  it("treats a size of 0 as rotation disabled", () => {
    expect(resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_SIZE_MB: "0" }).maxBytes).toBe(0);
  });
});

describe("rotateOpenLogFile", () => {
  const options = { maxBytes: 100, maxFiles: 3 };

  it("does nothing below the limit", async () => {
    write(logFile, "x".repeat(99));
    expect(await rotateOpenLogFile(logFile, options)).toBe(false);
    expect(names()).toEqual(["server.log"]);
  });

  it("rotates at the limit, keeping the content in .1 and emptying the live file", async () => {
    write(logFile, "a".repeat(100));
    expect(await rotateOpenLogFile(logFile, options)).toBe(true);
    expect(names()).toEqual(["server.log", "server.log.1"]);
    expect(fs.readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("a".repeat(100));
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("keeps only maxFiles files in total across repeated rotations", async () => {
    for (const letter of ["a", "b", "c", "d"]) {
      write(logFile, letter.repeat(100));
      await rotateOpenLogFile(logFile, options);
    }
    expect(names()).toEqual(["server.log", "server.log.1", "server.log.2"]);
    expect(fs.readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("d".repeat(100));
    expect(fs.readFileSync(path.join(dir, "server.log.2"), "utf8")).toBe("c".repeat(100));
  });

  it("keeps working while another handle holds the file open in append mode", async () => {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    await new Promise<void>((resolve) => stream.write("p".repeat(150), () => resolve()));
    expect(await rotateOpenLogFile(logFile, options)).toBe(true);
    await new Promise<void>((resolve) => stream.write("after", () => resolve()));
    await new Promise<void>((resolve) => stream.end(resolve));
    expect(fs.readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("p".repeat(150));
    expect(fs.readFileSync(logFile, "utf8")).toContain("after");
    expect(fs.statSync(logFile).size).toBeLessThan(100);
  });

  it("bounds the copy-then-truncate gap: a live writer loses at most the lines written during one copy", async () => {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    const total = 2000;
    const lineFor = (n: number) => `line-${String(n).padStart(5, "0")}\n`;
    let rotated = false;
    for (let n = 0; n < total; n++) {
      stream.write(lineFor(n));
      if (n === 1000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rotated = await rotateOpenLogFile(logFile, { maxBytes: 1, maxFiles: 2 });
      }
    }
    await new Promise<void>((resolve) => stream.end(resolve));
    expect(rotated).toBe(true);
    const archived = fs.readFileSync(path.join(dir, "server.log.1"), "utf8").split("\n").filter(Boolean);
    const live = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const seen = new Set([...archived, ...live]);
    // No duplicates, everything written before the copy is kept, and the loss is small.
    expect(seen.size).toBe(archived.length + live.length);
    expect(archived).toContain(lineFor(0).trim());
    expect(archived).toContain(lineFor(1000).trim());
    expect(total - seen.size).toBeLessThanOrEqual(100);
  });

  it("only truncates when maxFiles is 1", async () => {
    write(logFile, "z".repeat(200));
    expect(await rotateOpenLogFile(logFile, { maxBytes: 100, maxFiles: 1 })).toBe(true);
    expect(names()).toEqual(["server.log"]);
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("does nothing when rotation is disabled", async () => {
    write(logFile, "x".repeat(1000));
    expect(await rotateOpenLogFile(logFile, { maxBytes: 0, maxFiles: 3 })).toBe(false);
    expect(fs.statSync(logFile).size).toBe(1000);
  });

  it("does nothing when the log file does not exist", async () => {
    expect(await rotateOpenLogFile(logFile, options)).toBe(false);
  });
});

describe("rotateLogFileOnStartup", () => {
  it("renames an oversized file so its content is preserved and ages out later", () => {
    write(logFile, "o".repeat(500));
    expect(rotateLogFileOnStartup(logFile, { maxBytes: 100, maxFiles: 3 })).toBe(true);
    expect(names()).toEqual(["server.log.1"]);
    expect(fs.readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("o".repeat(500));
  });

  it("leaves a small file alone", () => {
    write(logFile, "small");
    expect(rotateLogFileOnStartup(logFile, { maxBytes: 100, maxFiles: 3 })).toBe(false);
    expect(names()).toEqual(["server.log"]);
  });
});

describe("archive pruning stays inside the log directory", () => {
  it("removes numbered archives beyond the keep count and nothing else", () => {
    write(logFile, "live");
    for (const index of [1, 2, 3, 4, 7]) write(path.join(dir, `server.log.${index}`), `old${index}`);
    write(path.join(dir, "server.log.bak"), "keep");
    write(path.join(dir, "server.log.1.bak"), "keep");
    write(path.join(dir, "other.log.9"), "keep");
    fs.mkdirSync(path.join(dir, "server.log.8"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-outside-"));
    write(path.join(outside, "server.log.9"), "outside");
    try {
      pruneLogArchives(logFile, 3);
      expect(names()).toEqual([
        "other.log.9",
        "server.log",
        "server.log.1",
        "server.log.1.bak",
        "server.log.2",
        "server.log.8",
        "server.log.bak",
      ]);
      expect(fs.readFileSync(path.join(outside, "server.log.9"), "utf8")).toBe("outside");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("startLogRotation", () => {
  it("rotates an oversized file at startup and then on the interval", async () => {
    write(logFile, "s".repeat(300));
    const handle = startLogRotation(logFile, { maxBytes: 100, maxFiles: 3 }, 20);
    try {
      expect(names()).toEqual(["server.log.1"]);
      write(logFile, "t".repeat(300));
      for (let attempt = 0; attempt < 100 && fs.statSync(logFile).size > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.statSync(logFile).size).toBe(0);
      expect(fs.readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("t".repeat(300));
      expect(fs.readFileSync(path.join(dir, "server.log.2"), "utf8")).toBe("s".repeat(300));
    } finally {
      handle.stop();
    }
  });
});
