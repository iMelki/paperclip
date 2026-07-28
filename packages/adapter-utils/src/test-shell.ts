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
    for (const binDir of ["usr/bin", "bin"]) {
      const candidate = path.join(root, "Git", binDir, `${command}.exe`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}
