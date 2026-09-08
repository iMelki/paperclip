import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTestShellCommand } from "./test-shell.js";

function fakeWindowsFiles(...paths: string[]): (candidate: string) => boolean {
  const files = new Set(paths.map((candidate) => path.win32.normalize(candidate).toLowerCase()));
  return (candidate) => files.has(path.win32.normalize(candidate).toLowerCase());
}

describe("resolveTestShellCommand", () => {
  it("leaves non-shell commands unchanged", () => {
    expect(resolveTestShellCommand("node", { platform: "win32" })).toBe("node");
  });

  it("uses the platform shell paths outside Windows", () => {
    expect(resolveTestShellCommand("sh", { platform: "linux" })).toBe("/bin/sh");
    expect(resolveTestShellCommand("bash", { platform: "darwin" })).toBe("/bin/bash");
  });

  it("derives an alternate Git for Windows root from git.exe on PATH", () => {
    const existsSync = fakeWindowsFiles(
      "D:\\Tools\\PortableGit\\cmd\\git.exe",
      "D:\\Tools\\PortableGit\\bin\\sh.exe",
    );

    expect(resolveTestShellCommand("sh", {
      platform: "win32",
      env: { Path: "C:\\Windows\\System32;D:\\Tools\\PortableGit\\cmd" },
      existsSync,
    })).toBe("D:\\Tools\\PortableGit\\bin\\sh.exe");
  });

  it("finds a per-user Git install when PATH is missing", () => {
    const existsSync = fakeWindowsFiles(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    );

    expect(resolveTestShellCommand("bash", {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      existsSync,
    })).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
  });

  it("does not accept a bare usr/bin shell without the Git launcher environment", () => {
    const existsSync = fakeWindowsFiles(
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    );

    expect(() => resolveTestShellCommand("sh", {
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      existsSync,
    })).toThrow("Unable to locate a usable Git for Windows sh.exe launcher");
  });
});
