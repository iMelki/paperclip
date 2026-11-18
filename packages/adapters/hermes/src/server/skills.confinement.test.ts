/**
 * Skill links are written only inside one verified Hermes home.
 *
 * The adapter creates and removes links in the Hermes skills directory. A symlink or Windows junction
 * in the home, its ancestors or the skills directory itself must not redirect those writes elsewhere,
 * and a directory swapped for a link between the check and the write must be detected and undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, ensurePaperclipSkillSymlink: vi.fn(actual.ensurePaperclipSkillSymlink) };
});

import { reconcileHermesPaperclipSkills } from "./skills.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const KEY = "paperclipai/paperclip/paperclip";

let root: string;
let source: string;
let outside: string;

/** A directory link that works without elevation on Windows (a junction) and as a symlink elsewhere. */
const linkDirectory = (target: string, at: string) => fs.symlink(target, at, "junction");

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-hermes-confine-"));
  source = path.join(root, "runtime-skills", "paperclip");
  outside = path.join(root, "outside");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function config(hermesHome: string, runtimeName = "paperclip") {
  return {
    env: { HERMES_HOME: hermesHome },
    paperclipRuntimeSkills: [{ key: KEY, runtimeName, source }],
  };
}
const reconcile = (cfg: Record<string, unknown>) => reconcileHermesPaperclipSkills(cfg, undefined, {});
const listing = async (dir: string) => (await fs.readdir(dir)).sort();

describe("Hermes skill links stay inside the verified home", () => {
  it("links the skill under a plain home and the link opens the skill", async () => {
    const home = path.join(root, "hermes-home");
    await reconcile(config(home));
    const link = path.join(home, "skills", "paperclip");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toContain("# Paperclip");
  });

  it("refuses a home that sits under a linked ancestor, and creates nothing behind the link", async () => {
    const linked = path.join(root, "linked-parent");
    await linkDirectory(outside, linked);
    await expect(reconcile(config(path.join(linked, "hermes-home")))).rejects.toThrow(/link/);
    expect(await listing(outside)).toEqual([]);
  });

  it("refuses a skills directory that is itself a link, and writes nothing through it", async () => {
    const home = path.join(root, "hermes-home");
    await fs.mkdir(home, { recursive: true });
    await linkDirectory(outside, path.join(home, "skills"));
    await expect(reconcile(config(home))).rejects.toThrow(/link/);
    expect(await listing(outside)).toEqual([]);
  });

  it("refuses a home that is itself a link", async () => {
    const home = path.join(root, "home-link");
    await linkDirectory(outside, home);
    await expect(reconcile(config(home))).rejects.toThrow(/link/);
    expect(await listing(outside)).toEqual([]);
  });

  it("detects a directory swapped for a link right before the write, undoes it and fails", async () => {
    const home = path.join(root, "hermes-home");
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
      "@paperclipai/adapter-utils/server-utils",
    );
    vi.mocked(serverUtils.ensurePaperclipSkillSymlink).mockImplementationOnce(async (from, to, linker) => {
      // The attacker replaces the verified skills directory with a link after it was checked.
      await fs.rm(path.join(home, "skills"), { recursive: true, force: true });
      await linkDirectory(outside, path.join(home, "skills"));
      return actual.ensurePaperclipSkillSymlink(from, to, linker);
    });
    await expect(reconcile(config(home))).rejects.toThrow(/link/);
    expect(await listing(outside)).toEqual([]);
  });

  it.each(["../escape", "..", ".", "a/b", "a\\b"])("refuses an unsafe skill name %j", async (name) => {
    const home = path.join(root, "hermes-home");
    await expect(reconcile(config(home, name))).rejects.toThrow();
    expect(await listing(outside)).toEqual([]);
    expect(await fs.readdir(root)).not.toContain("escape");
  });

  it("refuses a relative home", async () => {
    await expect(reconcile({ env: { HERMES_HOME: "relative-home" }, paperclipRuntimeSkills: [{ key: KEY, runtimeName: "paperclip", source }] }))
      .rejects.toThrow(/absolute/);
  });
});
