import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { toShellPath } from "@paperclipai/adapter-utils/shell-path";
import { resolveTestShellCommand } from "@paperclipai/adapter-utils/test-shell";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../../../scripts/kill-workspaces.sh", import.meta.url));
const tempRoots = new Set<string>();

type ScriptResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function createRegistryRecord(input: {
  pid: number;
  processGroupId?: number | null;
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kill-workspaces-"));
  tempRoots.add(tempRoot);
  const paperclipHome = path.join(tempRoot, "paperclip-home");
  const instanceId = "kill-workspaces-test";
  const runtimeDir = path.join(paperclipHome, "instances", instanceId, "runtime-services");
  const registryPath = path.join(runtimeDir, "workspace-runtime-test.json");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      version: 1,
      serviceKey: "workspace-runtime-test",
      profileKind: "workspace-runtime",
      serviceName: "preview",
      command: "node preview.js",
      cwd: tempRoot,
      envFingerprint: "test",
      port: null,
      url: null,
      pid: input.pid,
      processGroupId: input.processGroupId ?? null,
      provider: "local_process",
      runtimeServiceId: "runtime-test",
      reuseKey: null,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      metadata: null,
    }, null, 2)}\n`,
    "utf8",
  );
  return { paperclipHome, instanceId, registryPath };
}

async function runScript(input: {
  paperclipHome: string;
  instanceId: string;
  nodeBin?: string;
}): Promise<ScriptResult> {
  try {
    const result = await execFileAsync(
      resolveTestShellCommand("bash"),
      [scriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PAPERCLIP_HOME: toShellPath(input.paperclipHome),
          PAPERCLIP_INSTANCE_ID: input.instanceId,
          PAPERCLIP_KILL_WORKSPACES_ONLY_CURRENT: "1",
          ...(input.nodeBin
            ? { PAPERCLIP_KILL_WORKSPACES_NODE_BIN: toShellPath(input.nodeBin) }
            : {}),
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : Number(failure.code ?? 1),
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })));
  tempRoots.clear();
});

describe("kill-workspaces script", () => {
  it("retains live persisted-only evidence, sends no signal, and exits needs-human", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeTypeOf("number");
    try {
      await expect.poll(() => {
        try {
          process.kill(child.pid!, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 5_000 }).toBe(true);
      const fixture = await createRegistryRecord({ pid: child.pid!, processGroupId: null });

      const result = await runScript(fixture);

      expect(result.code).toBe(2);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/Needs human review[\s\S]*No signal was sent[\s\S]*retained/i);
      await expect(fs.access(fixture.registryPath)).resolves.toBeUndefined();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "retains dead-wrapper POSIX registrations with null or numerically absent process groups",
    async () => {
      for (const processGroupId of [null, 2_147_483_647]) {
        const fixture = await createRegistryRecord({
          pid: 2_147_483_647,
          processGroupId,
        });

        const result = await runScript(fixture);

        expect(result.code).toBe(2);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(
          /Needs human review[\s\S]*No signal was sent[\s\S]*retained/i,
        );
        await expect(fs.access(fixture.registryPath)).resolves.toBeUndefined();
      }
    },
  );

  it.skipIf(process.platform !== "win32")("retains a dead-wrapper Windows registration with a null process group", async () => {
    const fixture = await createRegistryRecord({ pid: 2_147_483_647, processGroupId: null });

    const result = await runScript(fixture);

    expect(result.code).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /Needs human review[\s\S]*No signal was sent[\s\S]*retained/i,
    );
    await expect(fs.access(fixture.registryPath)).resolves.toBeUndefined();
  });

  it("reports malformed registry evidence as needs-human and retains its bytes", async () => {
    const fixture = await createRegistryRecord({ pid: 2_147_483_647, processGroupId: null });
    const malformedBytes = "{\"version\":1,\n";
    await fs.writeFile(fixture.registryPath, malformedBytes, "utf8");

    const result = await runScript(fixture);

    expect(result.code).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /invalid-registry[\s\S]*Needs human review[\s\S]*retained/i,
    );
    await expect(fs.readFile(fixture.registryPath, "utf8")).resolves.toBe(malformedBytes);
  });

  it("reports parsed invalid-schema and service-key-mismatch evidence as needs-human", async () => {
    for (const variant of [
      "invalid-schema",
      "service-key-mismatch",
      "out-of-range-process-group",
      "blank-command",
    ] as const) {
      const fixture = await createRegistryRecord({ pid: 2_147_483_647, processGroupId: null });
      const original = JSON.parse(await fs.readFile(fixture.registryPath, "utf8")) as Record<string, unknown>;
      const bytes = variant === "invalid-schema"
        ? `${JSON.stringify({ version: 1, profileKind: "workspace-runtime" })}\n`
        : variant === "service-key-mismatch"
          ? `${JSON.stringify({ ...original, serviceKey: "different-service-key" })}\n`
          : variant === "out-of-range-process-group"
            ? `${JSON.stringify({ ...original, processGroupId: 2_147_483_648 })}\n`
            : `${JSON.stringify({ ...original, command: "   " })}\n`;
      await fs.writeFile(fixture.registryPath, bytes, "utf8");

      const result = await runScript(fixture);

      expect(result.code, variant).toBe(2);
      expect(`${result.stdout}\n${result.stderr}`, variant).toMatch(
        /invalid-registry[\s\S]*Needs human review[\s\S]*retained/i,
      );
      await expect(fs.readFile(fixture.registryPath, "utf8")).resolves.toBe(bytes);
    }
  });

  it("reports a registry-directory scan failure as needs-human", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kill-workspaces-scan-error-"));
    tempRoots.add(tempRoot);
    const paperclipHome = path.join(tempRoot, "paperclip-home");
    const instanceId = "kill-workspaces-scan-error";
    const instanceDir = path.join(paperclipHome, "instances", instanceId);
    const runtimePath = path.join(instanceDir, "runtime-services");
    const sentinelBytes = "not-a-directory\n";
    await fs.mkdir(instanceDir, { recursive: true });
    await fs.writeFile(runtimePath, sentinelBytes, "utf8");

    const result = await runScript({ paperclipHome, instanceId });

    expect(result.code).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /registry-scan-unreadable[\s\S]*Needs human review[\s\S]*retained/i,
    );
    await expect(fs.readFile(runtimePath, "utf8")).resolves.toBe(sentinelBytes);
  });

  it("propagates a registry-scanner crash and leaves every registry byte untouched", async () => {
    const fixture = await createRegistryRecord({ pid: 2_147_483_647, processGroupId: null });
    const originalBytes = await fs.readFile(fixture.registryPath, "utf8");
    const failingNode = path.join(path.dirname(fixture.paperclipHome), "failing-node.sh");
    await fs.writeFile(failingNode, "#!/usr/bin/env bash\nexit 17\n", "utf8");
    await fs.chmod(failingNode, 0o700);

    const result = await runScript({ ...fixture, nodeBin: failingNode });

    expect(result.code).toBe(3);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /registry scanner failed[\s\S]*No signal was sent[\s\S]*no registry record was removed/i,
    );
    await expect(fs.readFile(fixture.registryPath, "utf8")).resolves.toBe(originalBytes);
  });

  it("contains no TERM/KILL signal path or active-record cleanup path", async () => {
    const script = await fs.readFile(scriptPath, "utf8");
    expect(script).not.toMatch(/kill\s+-(?:TERM|KILL)|signal_target|Sending SIG/i);
    expect(script).not.toContain('"${active_files[@]:-}" "${stale_files[@]:-}"');
    expect(script).toContain('for file in "${stale_files[@]:-}"');
    expect(script).toContain("exit 2");
  });
});
