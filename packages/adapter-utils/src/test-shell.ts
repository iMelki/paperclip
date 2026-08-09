import fs from "node:fs";
import path from "node:path";

export function resolveTestShellCommand(command: string): string {
  if (command !== "sh" && command !== "bash") {
    return command;
  }

  if (process.platform !== "win32") {
    return command === "bash" ? "/bin/bash" : "/bin/sh";
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const roots = [programFiles, programFilesX86].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    // Git's launcher under bin/ seeds /usr/bin and /mingw64/bin for non-login
    // shells. Invoking usr/bin/sh.exe directly inherits the Windows PATH as-is,
    // which leaves core tools such as mkdir, rm, and base64 undiscoverable.
    for (const binDir of ["bin", "usr/bin"]) {
      const candidate = path.join(root, "Git", binDir, `${command}.exe`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

export function resolveTestScriptSpawn(command: string): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:c|m)?js$/i.test(command)) {
    return { command: process.execPath, args: [command] };
  }
  return { command, args: [] };
}
