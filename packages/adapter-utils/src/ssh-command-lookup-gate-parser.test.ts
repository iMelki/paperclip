import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Parser-swap guard: the gate now parses with vite parseSync (oxc ESTree)
// instead of the classic TypeScript compiler API, which TypeScript 7 removed.
// These fixtures prove TS-only syntax still reaches the shell/argv check and
// that the gate fails closed when it cannot parse its input.
const gatePath = fileURLToPath(
  new URL("../scripts/ssh-command-lookup-gate.mjs", import.meta.url),
);

function fixture(name: string) {
  return fileURLToPath(
    new URL(`../../../tests/fixtures/ssh-command-lookup/${name}`, import.meta.url),
  );
}

function invokeExactGate(sourcePath: string) {
  return spawnSync(process.execPath, [gatePath, "--source", sourcePath], {
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("SSH command lookup gate parser (vite parseSync)", () => {
  it("flags a known-bad lookup hidden behind TS wrappers, spreads and a namespace call", () => {
    const result = invokeExactGate(fixture("unsafe-ts-wrapped-ssh-command-lookup.ts.txt"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH_COMMAND_LOOKUP_UNSAFE");
    expect(result.stderr).toContain(":7:1 ");
    expect(result.stderr).toContain(
      "interpolated command lookup passed to shell executable /bin/dash",
    );
  });

  it("passes a clean shell call that performs no command lookup", () => {
    const result = invokeExactGate(fixture("clean-shell-without-lookup.ts.txt"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SSH_COMMAND_LOOKUP_SAFE");
    expect(result.stderr).toBe("");
  });

  it("fails closed with exit 2 when the source cannot be parsed", () => {
    const result = invokeExactGate(fixture("unparseable-ssh-command-lookup.ts.txt"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SSH_COMMAND_LOOKUP_GATE_ERROR");
  });
});
