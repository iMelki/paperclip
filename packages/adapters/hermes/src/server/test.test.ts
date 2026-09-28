import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testEnvironment } from "./test.js";

describe("Hermes local adapter environment test", () => {
  it("fails closed on incomplete strict isolation before probing the CLI or host credentials", async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { strictIsolation: true },
    });

    expect(result.adapterType).toBe("hermes_local");
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual(["hermes_strict_isolation_invalid"]);
    expect(result.checks[0]?.level).toBe("error");
    expect(Number.isNaN(Date.parse(result.testedAt))).toBe(false);
  });

  it("warns that effective auth remains unverified after synthetic launch inputs pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-environment-"));
    try {
      await fs.mkdir(path.join(root, "profiles", "research"), { recursive: true });
      await fs.mkdir(path.join(root, "bin"));
      await fs.writeFile(path.join(root, "profiles", "research", "profile.yaml"), "name: research\n");
      // This deliberately is not an executable: readiness must validate inputs without launching Hermes.
      await fs.writeFile(path.join(root, "bin", "hermes"), "synthetic command only\n");

      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          strictIsolation: true,
          hermesHome: root,
          hermesProfile: "research",
          hermesCommand: path.join(root, "bin", "hermes"),
          paperclipApiUrl: "http://127.0.0.1:3100/api",
          model: "gpt-5.5",
          provider: "openai-codex",
          timeoutSec: 900,
          maxTurnsPerRun: 3,
          persistSession: false,
        },
      });

      expect(result.adapterType).toBe("hermes_local");
      expect(result.status).toBe("warn");
      expect(result.checks.map((check) => check.code)).toEqual([
        "hermes_strict_effective_auth_unverified",
      ]);
      expect(result.checks[0]?.hint).toMatch(/provider-side hard stop/);
      expect(Number.isNaN(Date.parse(result.testedAt))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
