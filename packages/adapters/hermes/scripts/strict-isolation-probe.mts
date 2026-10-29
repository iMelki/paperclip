import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStrictHermesIsolation } from "../src/server/strict-isolation.ts";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-gate-"));
try {
  const profileDir = path.join(fixtureRoot, "profiles", "research");
  const commandDir = path.join(fixtureRoot, "bin");
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(commandDir);
  await fs.writeFile(path.join(profileDir, "profile.yaml"), "name: research\n");
  await fs.writeFile(path.join(commandDir, "hermes"), "fixture only\n");
  const badProfile = process.argv.includes("--bad-profile");
  const remoteApi = process.argv.includes("--remote-api");
  const config = {
    hermesHome: fixtureRoot,
    hermesProfile: badProfile ? "default" : "research",
    hermesCommand: path.join(commandDir, "hermes"),
    paperclipApiUrl: remoteApi ? "https://paperclip.example/api" : "http://127.0.0.1:3100/api",
    model: "gpt-5.5",
    provider: "openai-codex",
    timeoutSec: 900,
    maxTurnsPerRun: 3,
    persistSession: false,
  };
  try {
    const boundary = await resolveStrictHermesIsolation(config, { PATH: "fixture-path" });
    if (badProfile || remoteApi) throw new Error("negative fixture unexpectedly passed");
    if (boundary.env.HERMES_HOME !== fixtureRoot) throw new Error("isolated root was not resolved");
    process.stdout.write("accepted: named profile and isolated home\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`rejected: ${reason}\n`);
    process.exitCode = 1;
  }
} finally {
  await fs.rm(fixtureRoot, { recursive: true });
}
