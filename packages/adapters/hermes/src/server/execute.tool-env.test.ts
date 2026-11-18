/**
 * Tool-shell variables for hermes_local.
 *
 * Hermes strips secrets from the shell it gives its tools. A skill that declares
 * `required_environment_variables` in its frontmatter gets those variables registered for the tool
 * shell when the skill is loaded, and `hermes chat -s <skill>` loads it before the first turn. The
 * adapter therefore preloads the operational Paperclip skill; without it the agent cannot call the
 * Paperclip API (no run key, no run id). These tests pin that, the loopback API URL, the skills
 * directory on Windows, and the refusal to start without an explicit model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import { execute } from "./execute.js";
import { resolveHermesSkillsDir } from "./skills.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const SKILL_KEY = "paperclipai/paperclip/paperclip";
const MODEL = "anthropic/claude-haiku-5.5";

function makeCtx(config: Record<string, unknown>) {
  return {
    runId: "test-run-1",
    authToken: "fixture-run-token",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: process.execPath, timeoutSec: 60, graceSec: 5, ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

function lastSpawn() {
  const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[calls.length - 1];
  return { args: call[2] as string[], opts: call[3] as { env: Record<string, string> } };
}

describe("hermes_local requires an explicit model", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["unset", {}],
    ["empty", { model: "  " }],
    ["auto", { model: "auto" }],
    ["AUTO", { model: "AUTO" }],
    ["the OpenRouter auto router", { model: "openrouter/auto", provider: "openrouter" }],
    ["a provider-qualified auto router in any case", { model: "OpenRouter/AUTO" }],
  ])("refuses to start when the model is %s, before any child process", async (_label, config) => {
    await expect(execute(makeCtx(config) as never)).rejects.toThrow(/explicit model/);
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
  });

  it("starts with an explicit model and passes it through", async () => {
    await execute(makeCtx({ model: MODEL, provider: "openrouter" }) as never);
    const { args } = lastSpawn();
    expect(args[args.indexOf("-m") + 1]).toBe(MODEL);
  });
});

describe("hermes_local preloads the operational Paperclip skill", () => {
  let home: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-hermes-toolenv-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function runtimeSkill() {
    const source = path.join(home, "runtime-skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    return [{ key: SKILL_KEY, runtimeName: "paperclip", source }];
  }

  it("passes -s paperclip, so the declared variables reach the tool shell", async () => {
    const paperclipRuntimeSkills = await runtimeSkill();
    await execute(makeCtx({ model: MODEL, env: { HOME: home, HERMES_HOME: path.join(home, "hermes-home") }, paperclipRuntimeSkills }) as never);
    const { args } = lastSpawn();
    expect(args[args.indexOf("-s") + 1]).toBe("paperclip");
    expect((await fs.lstat(path.join(home, "hermes-home", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("negative: without the runtime skill there is no preload", async () => {
    await execute(makeCtx({ model: MODEL, env: { HOME: home } }) as never);
    expect(lastSpawn().args).not.toContain("-s");
  });
});

describe("hermes_local uses the configured loopback Paperclip API URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAPERCLIP_API_URL", "https://example-host.tailnet.example/api");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a configured loopback URL wins over the server's own value", async () => {
    await execute(makeCtx({ model: MODEL, paperclipApiUrl: "http://127.0.0.1:5113" }) as never);
    expect(lastSpawn().opts.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:5113/api");
  });

  it("negative: without a configured URL the server's value is kept", async () => {
    await execute(makeCtx({ model: MODEL }) as never);
    expect(lastSpawn().opts.env.PAPERCLIP_API_URL).toBe("https://example-host.tailnet.example/api");
  });
});

describe("Hermes skills directory", () => {
  const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });
  const realPlatform = process.platform;
  afterEach(() => setPlatform(realPlatform));
  const abs = (value: string) => path.resolve(value);

  it("an explicit HERMES_HOME wins", () => {
    expect(resolveHermesSkillsDir({ env: { HERMES_HOME: abs("/tmp/hermes-home"), HOME: abs("/srv/hermes-user") } }, { baseEnv: {} }))
      .toBe(path.join(abs("/tmp/hermes-home"), "skills"));
  });

  it("on Windows a configured LOCALAPPDATA selects Hermes' own default home", () => {
    setPlatform("win32");
    expect(resolveHermesSkillsDir({ env: { LOCALAPPDATA: abs("/profile/AppData/Local"), HOME: abs("/profile") } }, { baseEnv: {} }))
      .toBe(path.join(abs("/profile/AppData/Local"), "hermes", "skills"));
  });

  it("on Windows an inherited LOCALAPPDATA selects the home the child will really use", () => {
    setPlatform("win32");
    expect(resolveHermesSkillsDir({ env: { HOME: abs("/profile") } }, { baseEnv: { LOCALAPPDATA: abs("/server/AppData/Local") } }))
      .toBe(path.join(abs("/server/AppData/Local"), "hermes", "skills"));
  });

  it("an inherited HERMES_HOME is used, and the adapter env block overrides it", () => {
    expect(resolveHermesSkillsDir({}, { baseEnv: { HERMES_HOME: abs("/inherited") } })).toBe(path.join(abs("/inherited"), "skills"));
    expect(resolveHermesSkillsDir({ env: { HERMES_HOME: abs("/override") } }, { baseEnv: { HERMES_HOME: abs("/inherited") } }))
      .toBe(path.join(abs("/override"), "skills"));
  });

  it("strict isolation links into its own profile home, not the server user's home", () => {
    expect(resolveHermesSkillsDir({}, { baseEnv: { HERMES_HOME: abs("/inherited") }, strict: { root: abs("/iso"), profile: "worker" } }))
      .toBe(path.join(abs("/iso"), "profiles", "worker", "skills"));
  });

  it("otherwise the ~/.hermes layout applies, on any platform without LOCALAPPDATA", () => {
    setPlatform("linux");
    expect(resolveHermesSkillsDir({ env: { LOCALAPPDATA: abs("/ignored"), HOME: abs("/srv/hermes-user") } }, { baseEnv: {} }))
      .toBe(path.join(abs("/srv/hermes-user"), ".hermes", "skills"));
  });

  it("refuses a relative home", () => {
    expect(() => resolveHermesSkillsDir({ env: { HERMES_HOME: "relative/home" } }, { baseEnv: {} })).toThrow(/absolute/);
    expect(() => resolveHermesSkillsDir({ env: { HOME: "relative" } }, { baseEnv: {} })).toThrow(/absolute/);
  });
});

describe("the Paperclip skill declares every variable the adapter sets", () => {
  const skill = readFileSync(new URL("../../../../../skills/paperclip/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  // Only entries of the required_environment_variables list count, not any `name:` elsewhere in the frontmatter.
  const listBlock = frontmatter.match(/^required_environment_variables:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m)?.[1] ?? "";
  const declared = [...listBlock.matchAll(/^[ \t]*-[ \t]*name:[ \t]*(\S+)/gm)].map((match) => match[1]);

  it("reads a non-empty declaration list (the parser itself is checked)", () => {
    expect(declared.length).toBeGreaterThanOrEqual(9);
    const decoy = "name: PAPERCLIP_DECOY\nrequired_environment_variables:\n  - name: ONLY_THIS\nother:\n  - name: NOT_THIS\n";
    const block = decoy.match(/^required_environment_variables:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m)?.[1] ?? "";
    expect([...block.matchAll(/^[ \t]*-[ \t]*name:[ \t]*(\S+)/gm)].map((match) => match[1])).toEqual(["ONLY_THIS"]);
  });

  it.each([
    "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_TASK_ID", "PAPERCLIP_WAKE_REASON", "PAPERCLIP_WAKE_COMMENT_ID", "PAPERCLIP_WAKE_PAYLOAD_JSON",
  ])("declares %s under required_environment_variables", (name) => {
    expect(frontmatter).toMatch(/^required_environment_variables:/m);
    expect(declared).toContain(name);
  });

  it("the adapter sets exactly these variables (a new one must be declared too)", () => {
    const source = readFileSync(new URL("./execute.ts", import.meta.url), "utf8");
    const setByAdapter = new Set([...source.matchAll(/env\.(PAPERCLIP_[A-Z_]+)\s*=/g)].map((match) => match[1]));
    for (const name of setByAdapter) expect(declared, `${name} is set by the adapter`).toContain(name);
  });
});
