import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveStrictHermesIsolation } from "./strict-isolation.js";
import { testEnvironment } from "./test.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-isolation-"));
  const profileDir = path.join(root, "profiles", "research");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "profile.yaml"), "name: research\n");
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "bin", "hermes"), "fixture only\n");
  return { root, profileDir };
}

function config(root: string): Record<string, unknown> {
  return {
    hermesHome: root,
    hermesProfile: "research",
    hermesCommand: path.join(root, "bin", "hermes"),
    paperclipApiUrl: "http://127.0.0.1:3100/api",
    model: "gpt-5.5",
    provider: "openai-codex",
    timeoutSec: 900,
    maxTurnsPerRun: 3,
    persistSession: false,
  };
}

describe("strict Hermes local launch boundary", () => {
  it("passes only portable environment fields and pins the named profile home", async () => {
    const { root } = await fixture();
    try {
      const boundary = await resolveStrictHermesIsolation(config(root), {
        PATH: "safe-path",
        OPENAI_API_KEY: "root-only-canary",
        HERMES_HOME: "untrusted-root",
        NODE_OPTIONS: "--require attacker.js",
      });
      expect(boundary.profile).toBe("research");
      expect(boundary.timeoutSec).toBe(900);
      expect(boundary.maxTurns).toBe(3);
      expect(boundary.env.PATH).toBe("safe-path");
      expect(boundary.env.HERMES_HOME).toBe(root);
      expect(boundary.env.HOME).toBe(root);
      expect(boundary.env.OPENAI_API_KEY).toBeUndefined();
      expect(boundary.env.NODE_OPTIONS).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects missing, default, and unknown profiles", async () => {
    const { root } = await fixture();
    try {
      await expect(resolveStrictHermesIsolation({ ...config(root), hermesProfile: "default" }))
        .rejects.toThrow(/named hermesProfile/);
      await expect(resolveStrictHermesIsolation({ ...config(root), hermesProfile: "missing" }))
        .rejects.toThrow();
      await expect(resolveStrictHermesIsolation({ ...config(root), hermesProfile: "../escape" }))
        .rejects.toThrow(/named hermesProfile/);
      await expect(resolveStrictHermesIsolation({ ...config(root), hermesCommand: "hermes" }))
        .rejects.toThrow(/absolute Hermes command/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects env, extra arguments, unbounded runs, and session reuse", async () => {
    const { root } = await fixture();
    try {
      const base = config(root);
      await expect(resolveStrictHermesIsolation({ ...base, env: { OPENAI_API_KEY: "canary" } }))
        .rejects.toThrow(/env overrides/);
      await expect(resolveStrictHermesIsolation({ ...base, extraArgs: ["--yolo"] }))
        .rejects.toThrow(/extraArgs/);
      await expect(resolveStrictHermesIsolation({ ...base, timeoutSec: 1800 }))
        .rejects.toThrow(/1-900/);
      await expect(resolveStrictHermesIsolation({ ...base, maxTurnsPerRun: 4 }))
        .rejects.toThrow(/1-3 turns/);
      await expect(resolveStrictHermesIsolation({ ...base, persistSession: true }))
        .rejects.toThrow(/persistSession=false/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects remote Paperclip API hosts before passing the run token to Hermes", async () => {
    const { root } = await fixture();
    try {
      await expect(resolveStrictHermesIsolation({
        ...config(root), paperclipApiUrl: "https://paperclip.example/api",
      })).rejects.toThrow(/loopback Paperclip API URL/);
      await expect(resolveStrictHermesIsolation({
        ...config(root), paperclipApiUrl: "http://[::1]:3100/api",
      })).resolves.toMatchObject({ profile: "research" });
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects reuse of the host Hermes home even with a valid named profile", async () => {
    const { root } = await fixture();
    try {
      await expect(resolveStrictHermesIsolation(config(root), { HERMES_HOME: root }))
        .rejects.toThrow(/host Hermes home/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects the host user home and its ancestor but permits a separate child", async () => {
    const { root } = await fixture();
    const hostHome = path.join(root, "host-home");
    const isolated = path.join(hostHome, "isolated");
    const command = path.join(root, "bin", "hermes");
    try {
      for (const candidate of [hostHome, isolated]) {
        const profileDir = path.join(candidate, "profiles", "research");
        await fs.mkdir(profileDir, { recursive: true });
        await fs.writeFile(path.join(profileDir, "profile.yaml"), "name: research\n");
      }
      await expect(resolveStrictHermesIsolation(config(root), {}, hostHome))
        .rejects.toThrow(/host user home or its ancestor/);
      await expect(resolveStrictHermesIsolation({
        ...config(hostHome), hermesCommand: command,
      }, {}, hostHome)).rejects.toThrow(/host user home or its ancestor/);
      await expect(resolveStrictHermesIsolation({
        ...config(isolated), hermesCommand: command,
      }, {}, hostHome)).resolves.toMatchObject({ root: isolated, profile: "research" });
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("rejects the Windows local-app-data Hermes root", async () => {
    const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-localappdata-"));
    const root = path.join(localAppData, "Hermes");
    try {
      await fs.mkdir(path.join(root, "profiles", "research"), { recursive: true });
      await fs.mkdir(path.join(root, "bin"));
      await fs.writeFile(path.join(root, "profiles", "research", "profile.yaml"), "name: research\n");
      await fs.writeFile(path.join(root, "bin", "hermes"), "fixture only\n");
      await expect(resolveStrictHermesIsolation(config(root), { LOCALAPPDATA: localAppData }))
        .rejects.toThrow(/host Hermes home/);
    } finally {
      await fs.rm(localAppData, { recursive: true });
    }
  });

  it("readiness reports remaining effective-auth proof without reading host defaults", async () => {
    const { root } = await fixture();
    try {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { ...config(root), strictIsolation: true },
      });
      expect(result.status).toBe("warn");
      expect(result.checks.map((check) => check.code)).toContain("hermes_strict_effective_auth_unverified");
      expect(result.checks.map((check) => check.code)).not.toContain("hermes_api_keys_found");
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
