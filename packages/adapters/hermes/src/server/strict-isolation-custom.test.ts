import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveStrictHermesIsolation } from "./strict-isolation.js";

const PROXY_URL = "http://127.0.0.1:4141/v1/codex";

async function fixture(profileConfig?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-custom-"));
  const profileDir = path.join(root, "profiles", "research");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "profile.yaml"), "name: research\n");
  if (profileConfig !== undefined) await fs.writeFile(path.join(profileDir, "config.yaml"), profileConfig);
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "bin", "hermes"), "fixture only\n");
  return { root, profileDir };
}

function profileYaml(baseUrl: string, extra: string[] = []): string {
  return ["model:", "  default: gpt-5.5", "  provider: custom", `  base_url: ${baseUrl}`, ...extra, ""].join("\n");
}

function config(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hermesHome: root,
    hermesProfile: "research",
    hermesCommand: path.join(root, "bin", "hermes"),
    paperclipApiUrl: "http://127.0.0.1:3100/api",
    model: "gpt-5.5",
    provider: "custom",
    baseUrl: PROXY_URL,
    timeoutSec: 900,
    maxTurnsPerRun: 3,
    persistSession: false,
    ...overrides,
  };
}

describe("strict Hermes provider selection", () => {
  it("still rejects auto and providers outside the list with the unchanged error", async () => {
    const { root } = await fixture(profileYaml(PROXY_URL));
    try {
      const expected = /Strict Hermes isolation requires explicit model and provider/;
      await expect(resolveStrictHermesIsolation(config(root, { provider: "auto" }))).rejects.toThrow(expected);
      await expect(resolveStrictHermesIsolation(config(root, { provider: "not-a-provider" }))).rejects.toThrow(expected);
      await expect(resolveStrictHermesIsolation(config(root, { provider: "" }))).rejects.toThrow(expected);
      await expect(resolveStrictHermesIsolation(config(root, { provider: undefined }))).rejects.toThrow(expected);
      await expect(resolveStrictHermesIsolation(config(root, { model: "auto" }))).rejects.toThrow(expected);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("accepts custom with the explicit loopback proxy URL matching the profile config", async () => {
    const { root } = await fixture(profileYaml(PROXY_URL, ["  api_key: canary-secret-value"]));
    try {
      const boundary = await resolveStrictHermesIsolation(config(root));
      expect(boundary.profile).toBe("research");
      expect(boundary.baseUrl).toBe(PROXY_URL);
      expect(JSON.stringify(boundary)).not.toContain("canary-secret-value");
      const trailing = await resolveStrictHermesIsolation(config(root, { baseUrl: `${PROXY_URL}/` }));
      expect(trailing.baseUrl).toBe(PROXY_URL);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("does not require or expose a base URL for the other providers", async () => {
    const { root } = await fixture();
    try {
      const boundary = await resolveStrictHermesIsolation(
        config(root, { provider: "openai-codex", baseUrl: undefined }),
      );
      expect(boundary.baseUrl).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["localhost", "http://localhost:4141/v1"],
    ["IPv6 loopback", "http://[::1]:4141/v1"],
    ["LAN host", "http://10.0.0.5:4141/v1"],
    ["credentials", "http://user:pw@127.0.0.1:4141/v1"],
    ["query string", "http://127.0.0.1:4141/v1?x=1"],
    ["empty query string", "http://127.0.0.1:4141/v1?"],
    ["fragment", "http://127.0.0.1:4141/v1#frag"],
    ["public https host", "https://example.com/v1"],
    ["non-http scheme", "ftp://127.0.0.1:4141/v1"],
    ["not a URL", "127.0.0.1:4141"],
    ["leading space", " http://127.0.0.1:4141/v1"],
  ])("rejects a custom base URL that is %s", async (_label, baseUrl) => {
    const { root } = await fixture(profileYaml(PROXY_URL));
    try {
      await expect(resolveStrictHermesIsolation(config(root, { baseUrl })))
        .rejects.toThrow(/provider custom requires a loopback base URL/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("requires the profile config.yaml to declare a matching, valid base_url", async () => {
    const missing = await fixture();
    const wrongPort = await fixture(profileYaml("http://127.0.0.1:9999/v1/codex"));
    const noUrl = await fixture(["model:", "  default: gpt-5.5", "  provider: custom", ""].join("\n"));
    const remote = await fixture(profileYaml("https://example.com/v1"));
    const roots = [missing.root, wrongPort.root, noUrl.root, remote.root];
    try {
      await expect(resolveStrictHermesIsolation(config(missing.root))).rejects.toThrow(/config\.yaml to declare/);
      await expect(resolveStrictHermesIsolation(config(wrongPort.root))).rejects.toThrow(/to match the adapter baseUrl/);
      await expect(resolveStrictHermesIsolation(config(noUrl.root))).rejects.toThrow(/model\.base_url/);
      await expect(resolveStrictHermesIsolation(config(remote.root, { baseUrl: "https://example.com/v1" })))
        .rejects.toThrow(/loopback base URL/);
    } finally {
      for (const root of roots) await fs.rm(root, { recursive: true });
    }
  });

  it("keeps the other strict rules in force for custom", async () => {
    const { root } = await fixture(profileYaml(PROXY_URL));
    try {
      await expect(resolveStrictHermesIsolation(config(root, { env: { X: "1" } }))).rejects.toThrow(/env overrides/);
      await expect(resolveStrictHermesIsolation(config(root, { persistSession: true })))
        .rejects.toThrow(/persistSession=false/);
      await expect(resolveStrictHermesIsolation(config(root, { timeoutSec: 901 }))).rejects.toThrow(/1-900/);
      await expect(resolveStrictHermesIsolation(config(root, { paperclipApiUrl: "https://paperclip.example/api" })))
        .rejects.toThrow(/loopback Paperclip API URL/);
      await expect(resolveStrictHermesIsolation(config(root, { hermesProfile: "default" })))
        .rejects.toThrow(/named hermesProfile/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
