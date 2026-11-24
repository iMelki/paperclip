import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOG_MAX_FILES,
  DEFAULT_LOG_MAX_SIZE_MB,
  MAX_LOG_MAX_SIZE_MB,
  pruneLogArchives,
  reportLogRotationError,
  resetLogRotationErrorReports,
  resolveLogRotationOptions,
  rotateLogFile,
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

function read(name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-rotation-"));
  logFile = path.join(dir, "server.log");
  resetLogRotationErrorReports();
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

  it("does not let a tiny or huge size silently disable rotation", () => {
    expect(resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_SIZE_MB: "0.0000001" }).maxBytes).toBe(
      DEFAULT_LOG_MAX_SIZE_MB * 1024 * 1024,
    );
    const huge = resolveLogRotationOptions({ PAPERCLIP_LOG_MAX_SIZE_MB: "1e308", PAPERCLIP_LOG_MAX_FILES: "1e9" });
    expect(huge.maxBytes).toBe(MAX_LOG_MAX_SIZE_MB * 1024 * 1024);
    expect(Number.isFinite(huge.maxBytes)).toBe(true);
    expect(huge.maxFiles).toBeLessThanOrEqual(100);
  });
});

describe("rotateLogFile", () => {
  const options = { maxBytes: 100, maxFiles: 3 };

  it("does nothing below the limit", async () => {
    write(logFile, "x".repeat(99));
    expect(await rotateLogFile(logFile, options)).toBe(false);
    expect(names()).toEqual(["server.log"]);
  });

  it("rotates at the limit, keeping the content in .1 and emptying the live file", async () => {
    write(logFile, "a".repeat(100));
    expect(await rotateLogFile(logFile, options)).toBe(true);
    expect(names()).toEqual(["server.log", "server.log.1"]);
    expect(read("server.log.1")).toBe("a".repeat(100));
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("keeps only maxFiles files in total across repeated rotations", async () => {
    for (const letter of ["a", "b", "c", "d"]) {
      write(logFile, letter.repeat(100));
      await rotateLogFile(logFile, options);
    }
    expect(names()).toEqual(["server.log", "server.log.1", "server.log.2"]);
    expect(read("server.log.1")).toBe("d".repeat(100));
    expect(read("server.log.2")).toBe("c".repeat(100));
  });

  it("keeps working while another handle holds the file open in append mode", async () => {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    await new Promise<void>((resolve) => stream.write("p".repeat(150), () => resolve()));
    expect(await rotateLogFile(logFile, options)).toBe(true);
    await new Promise<void>((resolve) => stream.write("after", () => resolve()));
    await new Promise<void>((resolve) => stream.end(resolve));
    expect(read("server.log.1")).toBe("p".repeat(150));
    expect(read("server.log")).toContain("after");
    expect(fs.statSync(logFile).size).toBeLessThan(100);
  });

  it("only truncates when maxFiles is 1", async () => {
    write(logFile, "z".repeat(200));
    expect(await rotateLogFile(logFile, { maxBytes: 100, maxFiles: 1 })).toBe(true);
    expect(names()).toEqual(["server.log"]);
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("removes older archives too when maxFiles is 1 (G1)", async () => {
    write(logFile, "z".repeat(200));
    write(path.join(dir, "server.log.1"), "old1");
    write(path.join(dir, "server.log.3"), "old3");
    expect(await rotateLogFile(logFile, { maxBytes: 100, maxFiles: 1 })).toBe(true);
    expect(names()).toEqual(["server.log"]);
  });

  it("does nothing when rotation is disabled or the file is missing", async () => {
    expect(await rotateLogFile(logFile, options)).toBe(false);
    write(logFile, "x".repeat(1000));
    expect(await rotateLogFile(logFile, { maxBytes: 0, maxFiles: 3 })).toBe(false);
    expect(fs.statSync(logFile).size).toBe(1000);
  });

  it("does not shift or delete archives when the copy fails, and still truncates (N1)", async () => {
    write(logFile, "n".repeat(200));
    write(path.join(dir, "server.log.1"), "keep1");
    write(path.join(dir, "server.log.2"), "keep2");
    // A directory squatting on the temp name makes the copy fail.
    fs.mkdirSync(path.join(dir, "server.log.rotating"));
    const errors: unknown[] = [];
    expect(await rotateLogFile(logFile, options, (error) => errors.push(error))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(read("server.log.1")).toBe("keep1");
    expect(read("server.log.2")).toBe("keep2");
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("is not stuck for good when an archive rename fails (N2)", async () => {
    write(logFile, "m".repeat(200));
    write(path.join(dir, "server.log.1"), "old1");
    // A non-empty directory at the rename target makes renaming .1 -> .2 fail.
    fs.mkdirSync(path.join(dir, "server.log.2"));
    write(path.join(dir, "server.log.2", "inside"), "x");
    const errors: unknown[] = [];
    expect(await rotateLogFile(logFile, { maxBytes: 100, maxFiles: 4 }, (error) => errors.push(error))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(fs.statSync(logFile).size).toBe(0);
    expect(read("server.log.1")).toBe("m".repeat(200));
    // The next rotation proceeds normally.
    write(logFile, "k".repeat(200));
    expect(await rotateLogFile(logFile, { maxBytes: 100, maxFiles: 4 }, (error) => errors.push(error))).toBe(true);
    expect(read("server.log.1")).toBe("k".repeat(200));
  });
});

describe("rotation failure reporting (N3)", () => {
  it("writes one stderr line per error code per hour", () => {
    const lines: string[] = [];
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    expect(reportLogRotationError(error, (line) => lines.push(line), 1_000)).toBe(true);
    expect(reportLogRotationError(error, (line) => lines.push(line), 2_000)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ENOSPC");
    expect(lines[0]).toContain("disk full");
    const other = Object.assign(new Error("busy"), { code: "EBUSY" });
    expect(reportLogRotationError(other, (line) => lines.push(line), 3_000)).toBe(true);
    expect(reportLogRotationError(error, (line) => lines.push(line), 1_000 + 61 * 60 * 1000)).toBe(true);
    expect(lines).toHaveLength(3);
  });
});

describe("concurrent writer in another thread", () => {
  it("loses only a bounded number of lines and never duplicates or reorders them (N4)", async () => {
    const control = new Int32Array(new SharedArrayBuffer(8)); // [0] = lines written, [1] = stop flag
    const workerCode = `
      const { workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const control = new Int32Array(workerData.sab);
      const fd = fs.openSync(workerData.file, "a");
      let n = 0;
      while (Atomics.load(control, 1) === 0) {
        fs.writeSync(fd, "line-" + String(n).padStart(8, "0") + " padding-padding-padding-padding\\n");
        n++;
        Atomics.store(control, 0, n);
      }
      fs.closeSync(fd);
    `;
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { sab: control.buffer, file: logFile },
    });
    const waitForLines = async (target: number) => {
      for (let attempt = 0; attempt < 2000 && Atomics.load(control, 0) < target; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(Atomics.load(control, 0)).toBeGreaterThanOrEqual(target);
    };
    try {
      await waitForLines(5000);
      const rotated = await rotateLogFile(logFile, { maxBytes: 1, maxFiles: 2 });
      expect(rotated).toBe(true);
      await waitForLines(Atomics.load(control, 0) + 5000);
    } finally {
      Atomics.store(control, 1, 1);
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    }

    const total = Atomics.load(control, 0);
    const parse = (text: string) =>
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => Number(line.slice(5, 13)));
    const archived = parse(read("server.log.1"));
    const live = parse(read("server.log"));
    const all = [...archived, ...live];

    // Each file is strictly increasing, the archive precedes the live file, and nothing repeats.
    for (const seq of [archived, live]) {
      for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
    }
    expect(new Set(all).size).toBe(all.length);
    expect(archived.length).toBeGreaterThanOrEqual(5000);
    expect(archived[0]).toBe(0);
    if (archived.length && live.length) expect(live[0]).toBeGreaterThan(archived[archived.length - 1]);
    // The lost-line window is one copy of a file this size, a small share of what was written.
    const lost = total - all.length;
    expect(lost).toBeGreaterThanOrEqual(0);
    expect(lost).toBeLessThan(total * 0.25);
  }, 60_000);
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
      expect(read("server.log.2")).toBe("old2");
      expect(fs.readFileSync(path.join(outside, "server.log.9"), "utf8")).toBe("outside");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("startLogRotation", () => {
  it("rotates an oversized file at start and then on the interval, without renaming the live file", async () => {
    const held = fs.openSync(logFile, "a");
    fs.writeSync(held, "s".repeat(300));
    const handle = startLogRotation(logFile, { maxBytes: 100, maxFiles: 3 }, 20);
    try {
      for (let attempt = 0; attempt < 200 && fs.statSync(logFile).size > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(names()).toEqual(["server.log", "server.log.1"]);
      expect(read("server.log.1")).toBe("s".repeat(300));
      // A handle opened before startup still writes into the live server.log.
      fs.writeSync(held, "t".repeat(300));
      for (let attempt = 0; attempt < 200 && fs.statSync(logFile).size > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(read("server.log.1")).toBe("t".repeat(300));
      expect(read("server.log.2")).toBe("s".repeat(300));
    } finally {
      handle.stop();
      fs.closeSync(held);
    }
  });

  it("returns the same handle when started twice for one file", () => {
    const a = startLogRotation(logFile, { maxBytes: 100, maxFiles: 3 }, 1000);
    const b = startLogRotation(logFile, { maxBytes: 100, maxFiles: 3 }, 1000);
    try {
      expect(b).toBe(a);
    } finally {
      a.stop();
    }
  });
});

describe("importing the logger never rotates or prunes (B1)", () => {
  const envKeys = ["PAPERCLIP_LOG_DIR", "PAPERCLIP_LOG_MAX_SIZE_MB", "PAPERCLIP_LOG_MAX_FILES"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.doUnmock("pino");
    vi.resetModules();
  });

  function snapshot(target: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of fs.readdirSync(target).sort()) out[name] = fs.readFileSync(path.join(target, name), "utf8");
    return out;
  }

  it("leaves oversized logs in both the configured test dir and a decoy live dir untouched", async () => {
    vi.doMock("pino", () => {
      const fn: any = vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() }));
      fn.transport = vi.fn(() => ({ write: vi.fn() }));
      return { default: fn };
    });
    vi.doMock("pino-http", () => ({ pinoHttp: vi.fn(() => vi.fn()) }));

    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-decoy-live-"));
    try {
      write(path.join(decoy, "server.log"), "D".repeat(5000));
      write(path.join(decoy, "server.log.1"), "d1");
      write(path.join(decoy, "server.log.7"), "d7");
      const decoyBefore = snapshot(decoy);

      process.env.PAPERCLIP_LOG_DIR = dir;
      process.env.PAPERCLIP_LOG_MAX_SIZE_MB = "0.001";
      process.env.PAPERCLIP_LOG_MAX_FILES = "2";
      write(logFile, "L".repeat(5000));
      write(path.join(dir, "server.log.1"), "one");
      write(path.join(dir, "server.log.7"), "seven");
      const dirBefore = snapshot(dir);

      await import("../middleware/logger.js");
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(snapshot(decoy)).toEqual(decoyBefore);
      expect(snapshot(dir)).toEqual(dirBefore);

      // Positive control: only the explicit start rotates, and only the directory it is given.
      const handle = startLogRotation(logFile, resolveLogRotationOptions(process.env), 1000);
      try {
        for (let attempt = 0; attempt < 200 && fs.statSync(logFile).size > 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fs.statSync(logFile).size).toBe(0);
        expect(snapshot(decoy)).toEqual(decoyBefore);
      } finally {
        handle.stop();
      }
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });
});
