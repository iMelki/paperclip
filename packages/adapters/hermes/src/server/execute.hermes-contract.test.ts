/**
 * Contract with the real Hermes CLI code, without a model call.
 *
 * The mocked tests prove the adapter passes `-s paperclip`; they cannot prove Hermes then finds the
 * skill and registers the variables it declares for the tool shell. This test links the BUNDLED skill
 * with the adapter's own reconciliation into a scratch Hermes home, then asks the real Hermes Python
 * code to preload it, exactly as `hermes chat -s` does before the first turn, and checks that every
 * required variable is registered afterwards (and none before).
 *
 * It needs a Hermes source checkout, so it runs only when HERMES_CONTRACT_SOURCE points at one
 * (optionally HERMES_CONTRACT_PYTHON for the interpreter). CI without Hermes skips it by design.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileHermesPaperclipSkills } from "./skills.js";

const hermesSource = process.env.HERMES_CONTRACT_SOURCE?.trim();
const python = process.env.HERMES_CONTRACT_PYTHON?.trim() || "python";
const bundledSkill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../skills/paperclip");

const SCRIPT = `
import json, os, sys
sys.path.insert(0, os.environ["HERMES_CONTRACT_SOURCE"])
from tools.env_passthrough import is_env_passthrough
names = json.loads(os.environ["CONTRACT_NAMES"])
before = {n: bool(is_env_passthrough(n)) for n in names}
from agent.skill_commands import build_preloaded_skills_prompt
text, loaded, missing = build_preloaded_skills_prompt(["paperclip"])
after = {n: bool(is_env_passthrough(n)) for n in names}
print(json.dumps({"loaded": list(loaded), "missing": list(missing), "before": before, "after": after}))
`;

function requiredVariableNames(): string[] {
  const skill = readFileSync(path.join(bundledSkill, "SKILL.md"), "utf8");
  const block = skill.match(/^required_environment_variables:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m)?.[1] ?? "";
  return block.split(/\r?\n(?=[ \t]*-[ \t]*name:)/)
    .filter((entry) => !/optional:[ \t]*true/.test(entry))
    .map((entry) => entry.match(/name:[ \t]*(\S+)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

describe.skipIf(!hermesSource)("real Hermes preloads the bundled Paperclip skill the adapter links", () => {
  let home: string;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-hermes-contract-")); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it("finds the linked skill and registers every required variable for the tool shell", async () => {
    const hermesHome = path.join(home, "hermes-home");
    await reconcileHermesPaperclipSkills({
      env: { HERMES_HOME: hermesHome },
      paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: bundledSkill }],
    }, undefined, {});
    const names = requiredVariableNames();
    expect(names).toEqual(expect.arrayContaining(["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID"]));
    const run = spawnSync(python, ["-I", "-c", SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        HERMES_CONTRACT_SOURCE: hermesSource,
        CONTRACT_NAMES: JSON.stringify(names),
        // Dummy values: registration needs the variables to exist, and these are not secrets.
        ...Object.fromEntries(names.map((name) => [name, `contract-dummy-${name.toLowerCase()}`])),
      },
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() ?? "{}") as {
      loaded: string[]; missing: string[]; before: Record<string, boolean>; after: Record<string, boolean>;
    };
    expect(out.missing).toEqual([]);
    expect(out.loaded).toContain("paperclip");
    for (const name of names) {
      expect(out.before[name], `${name} must not be registered before the skill loads`).toBe(false);
      expect(out.after[name], `${name} must be registered after the preload`).toBe(true);
    }
  }, 120_000);
});
