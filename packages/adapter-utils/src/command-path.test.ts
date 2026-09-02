import { constants as fsConstants } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveCommandPath } from "./command-path.js";

const fileStat = async () => ({ isFile: () => true });

describe("resolveCommandPath", () => {
  it("reads Windows PATH and PATHEXT names case-insensitively without invoking a shell", async () => {
    const attempted: Array<{ candidate: string; mode: number }> = [];
    const available = "D:\\Bin\\ssh.EXE";

    const resolved = await resolveCommandPath(
      "ssh",
      "C:\\workspace",
      { path: "C:\\Tools;D:\\Bin", pathext: ".CMD;.EXE" },
      {
        platform: "win32",
        stat: fileStat,
        access: async (candidate, mode) => {
          attempted.push({ candidate, mode });
          if (candidate !== available) throw new Error("not found");
        },
      },
    );

    expect(resolved).toBe(available);
    expect(attempted).toEqual([
      { candidate: "C:\\Tools\\ssh.CMD", mode: fsConstants.F_OK },
      { candidate: "C:\\Tools\\ssh.EXE", mode: fsConstants.F_OK },
      { candidate: "C:\\Tools\\ssh", mode: fsConstants.F_OK },
      { candidate: "D:\\Bin\\ssh.CMD", mode: fsConstants.F_OK },
      { candidate: "D:\\Bin\\ssh.EXE", mode: fsConstants.F_OK },
    ]);
  });

  it("uses the documented Windows PATHEXT default when it is unset", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath(
      "ssh",
      "C:\\workspace",
      { PATH: "C:\\Tools" },
      {
        platform: "win32",
        stat: fileStat,
        access: async (candidate) => {
          attempted.push(candidate);
          if (candidate !== "C:\\Tools\\ssh.COM") throw new Error("not found");
        },
      },
    );

    expect(resolved).toBe("C:\\Tools\\ssh.COM");
    expect(attempted).toEqual(["C:\\Tools\\ssh.COM"]);
  });

  it("uses Node's first lexicographic Windows environment-key match", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath(
      "ssh",
      "C:\\workspace",
      {
        Path: "C:\\First",
        path: "D:\\Later",
        Pathext: ".CMD",
        pathext: ".EXE",
      },
      {
        platform: "win32",
        stat: fileStat,
        access: async (candidate) => {
          attempted.push(candidate);
          if (candidate !== "C:\\First\\ssh.CMD") throw new Error("not found");
        },
      },
    );

    expect(resolved).toBe("C:\\First\\ssh.CMD");
    expect(attempted).toEqual(["C:\\First\\ssh.CMD"]);
  });

  it("uses an injectable current-process PATH when a Windows child env omits PATH", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath(
      "ssh",
      "C:\\workspace",
      { PATHEXT: ".EXE" },
      {
        platform: "win32",
        fallbackEnv: { pAtH: "C:\\CurrentProcess" },
        stat: fileStat,
        access: async (candidate) => {
          attempted.push(candidate);
          if (candidate !== "C:\\CurrentProcess\\ssh.EXE") throw new Error("not found");
        },
      },
    );

    expect(resolved).toBe("C:\\CurrentProcess\\ssh.EXE");
    expect(attempted).toEqual(["C:\\CurrentProcess\\ssh.EXE"]);
  });

  it("does not replace an explicitly empty Windows PATH with the fallback PATH", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath(
      "ssh",
      "C:\\workspace",
      { PATH: "", PATHEXT: ".EXE" },
      {
        platform: "win32",
        fallbackEnv: { PATH: "C:\\CurrentProcess" },
        stat: fileStat,
        access: async (candidate) => {
          attempted.push(candidate);
          throw new Error("not found");
        },
      },
    );

    expect(resolved).toBeNull();
    expect(attempted).toEqual(["C:\\workspace\\ssh.EXE", "C:\\workspace\\ssh"]);
  });

  it("requires executable access while resolving a POSIX PATH", async () => {
    const attempted: Array<{ candidate: string; mode: number }> = [];

    const resolved = await resolveCommandPath(
      "ssh",
      "/workspace",
      { PATH: "/usr/local/bin:/usr/bin" },
      {
        platform: "linux",
        stat: fileStat,
        access: async (candidate, mode) => {
          attempted.push({ candidate, mode });
          if (candidate !== "/usr/bin/ssh") throw new Error("not found");
        },
      },
    );

    expect(resolved).toBe("/usr/bin/ssh");
    expect(attempted).toEqual([
      { candidate: "/usr/local/bin/ssh", mode: fsConstants.X_OK },
      { candidate: "/usr/bin/ssh", mode: fsConstants.X_OK },
    ]);
  });

  it("uses Node's POSIX default PATH when PATH is unset", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath("ssh", "/workspace", {}, {
      platform: "linux",
      stat: fileStat,
      access: async (candidate) => {
        attempted.push(candidate);
        if (candidate !== "/bin/ssh") throw new Error("not found");
      },
    });

    expect(resolved).toBe("/bin/ssh");
    expect(attempted).toEqual(["/usr/bin/ssh", "/bin/ssh"]);
  });

  it("treats an empty POSIX PATH segment as the current directory", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath("ssh", "/workspace", { PATH: ":/usr/bin" }, {
      platform: "linux",
      stat: fileStat,
      access: async (candidate) => {
        attempted.push(candidate);
        if (candidate !== "/workspace/ssh") throw new Error("not found");
      },
    });

    expect(resolved).toBe("/workspace/ssh");
    expect(attempted).toEqual(["/workspace/ssh"]);
  });

  it("treats a POSIX backslash as a literal filename character", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath("ssh\\helper", "/workspace", { PATH: "/usr/bin" }, {
      platform: "linux",
      stat: fileStat,
      access: async (candidate) => {
        attempted.push(candidate);
        throw new Error("not found");
      },
    });

    expect(resolved).toBeNull();
    expect(attempted).toEqual(["/usr/bin/ssh\\helper"]);
  });

  it("classifies a Windows drive-relative command as path-like", async () => {
    const attempted: string[] = [];
    const resolved = await resolveCommandPath("C:ssh.exe", "C:\\workspace", {}, {
      platform: "win32",
      stat: fileStat,
      access: async (candidate) => {
        attempted.push(candidate);
      },
    });

    expect(resolved).toBe("C:\\workspace\\ssh.exe");
    expect(attempted).toEqual(["C:\\workspace\\ssh.exe"]);
  });

  it("rejects a directory even when the access check would pass", async () => {
    let accessCalled = false;
    const resolved = await resolveCommandPath("ssh", "/workspace", { PATH: "/usr/bin" }, {
      platform: "linux",
      stat: async () => ({ isFile: () => false }),
      access: async () => {
        accessCalled = true;
      },
    });

    expect(resolved).toBeNull();
    expect(accessCalled).toBe(false);
  });

  it("treats shell metacharacters as literal filename characters", async () => {
    const attempted: string[] = [];

    const resolved = await resolveCommandPath(
      "ssh;touch owned",
      "/workspace",
      { PATH: "/usr/bin" },
      {
        platform: "linux",
        stat: fileStat,
        access: async (candidate) => {
          attempted.push(candidate);
          throw new Error("not found");
        },
      },
    );

    expect(resolved).toBeNull();
    expect(attempted).toEqual(["/usr/bin/ssh;touch owned"]);
  });
});

describe("quoteForCmd and Windows shell resolution", () => {
  it("safely quotes Windows paths with spaces and metacharacters for cmd.exe", async () => {
    const { quoteForCmd, resolveWindowsCmdShell } = await import("./server-utils.js");
    expect(quoteForCmd("")).toBe('""');
    expect(quoteForCmd("C:\\normal\\path.cmd")).toBe("C:\\normal\\path.cmd");
    expect(quoteForCmd("C:\\Program Files\\Gemini CLI\\gemini.cmd")).toBe(
      '"C:\\Program Files\\Gemini CLI\\gemini.cmd"',
    );
    expect(quoteForCmd("C:\\Tools (x86)\\test & run.bat")).toBe(
      '"C:\\Tools (x86)\\test & run.bat"',
    );
    expect(quoteForCmd('C:\\path with "quotes"\\tool.cmd')).toBe(
      '"C:\\path with ""quotes""\\tool.cmd"',
    );

    const shell = resolveWindowsCmdShell();
    expect(shell.toLowerCase()).toContain("cmd.exe");
    expect(shell.toLowerCase()).toContain("system32");
  });
});

