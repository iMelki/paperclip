import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatePath = fileURLToPath(
  new URL("../scripts/ssh-command-lookup-gate.mjs", import.meta.url),
);
const unsafeFixturePath = fileURLToPath(
  new URL("../test-fixtures/unsafe-ssh-command-lookup.ts.txt", import.meta.url),
);
const passiveFixturePath = fileURLToPath(
  new URL("../test-fixtures/passive-ssh-command-description.ts.txt", import.meta.url),
);
const importAliasedFixturePath = fileURLToPath(
  new URL("../test-fixtures/unsafe-import-aliased-ssh-command-lookup.ts.txt", import.meta.url),
);
const zshWhichFixturePath = fileURLToPath(
  new URL("../test-fixtures/unsafe-zsh-which-command-lookup.ts.txt", import.meta.url),
);

function invokeExactGate(sourcePath?: string) {
  return spawnSync(
    process.execPath,
    sourcePath ? [gatePath, "--source", sourcePath] : [gatePath],
    { encoding: "utf8", windowsHide: true },
  );
}

describe("SSH command lookup shell-safety ratchet", () => {
  it("keeps the real adapter-utils SSH command discovery source shell-free", () => {
    const result = invokeExactGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SSH_COMMAND_LOOKUP_SAFE");
    expect(result.stderr).toBe("");
  });

  it("makes the exact gate caller fail for the unsafe aliased repo fixture", () => {
    const result = invokeExactGate(unsafeFixturePath);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH_COMMAND_LOOKUP_UNSAFE");
    expect(result.stderr).toContain(
      "interpolated command lookup passed to shell executable /bin/sh",
    );
  });

  it("does not label a passive command description as process execution", () => {
    const result = invokeExactGate(passiveFixturePath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SSH_COMMAND_LOOKUP_SAFE");
    expect(result.stderr).toBe("");
  });

  it("fails when a named child-process import aliases the launcher", () => {
    const result = invokeExactGate(importAliasedFixturePath);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH_COMMAND_LOOKUP_UNSAFE");
    expect(result.stderr).toContain(
      "interpolated command lookup passed to shell executable /usr/bin/bash",
    );
  });

  it("fails for which under another POSIX shell with a composite command flag", () => {
    const result = invokeExactGate(zshWhichFixturePath);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH_COMMAND_LOOKUP_UNSAFE");
    expect(result.stderr).toContain(
      "interpolated command lookup passed to shell executable /usr/bin/zsh",
    );
  });
});
