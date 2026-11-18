import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  PAPERCLIP_OPERATIONAL_SKILL_KEY,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The variables the Hermes child process will actually see: the server's, then the adapter env block. */
function effectiveEnv(config: Record<string, unknown>, baseEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const block =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const merged: Record<string, string | undefined> = { ...baseEnv };
  for (const [key, value] of Object.entries(block)) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

/** Windows environment names are case-insensitive; match them that way so a differently cased copy still counts. */
function readEnv(env: Record<string, string | undefined>, name: string): string | null {
  if (process.platform !== "win32") return asString(env[name]);
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? asString(env[key]) : null;
}

export interface HermesHomeOptions {
  /** Variables the child inherits. Defaults to the server process environment. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Strict isolation launches with a separate root and a named profile, which is the home Hermes uses. */
  strict?: { root: string; profile: string };
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`Hermes ${label} must be an absolute path (got a relative one); set an absolute HERMES_HOME.`);
  }
  return path.resolve(value);
}

/**
 * Directory Hermes reads its skills from, derived from the environment the child will really get
 * (the server's variables plus the adapter env block), so one value serves both linking and launch.
 * Strict isolation uses `<root>/profiles/<profile>`. Otherwise an explicit HERMES_HOME wins; on
 * Windows Hermes' own default home is %LOCALAPPDATA%/hermes; elsewhere the ~/.hermes layout applies.
 * Relative locations are refused.
 */
export function resolveHermesSkillsDir(config: Record<string, unknown>, options: HermesHomeOptions = {}): string {
  if (options.strict) {
    return path.join(requireAbsolute(options.strict.root, "strict root"), "profiles", options.strict.profile, "skills");
  }
  const env = effectiveEnv(config, options.baseEnv ?? process.env);
  const explicitHome = readEnv(env, "HERMES_HOME");
  if (explicitHome) return path.join(requireAbsolute(explicitHome, "HERMES_HOME"), "skills");
  const localAppData = readEnv(env, "LOCALAPPDATA");
  if (process.platform === "win32" && localAppData) {
    return path.join(requireAbsolute(localAppData, "LOCALAPPDATA"), "hermes", "skills");
  }
  const configuredHome = readEnv(env, "HOME");
  return path.join(configuredHome ? requireAbsolute(configuredHome, "HOME") : os.homedir(), ".hermes", "skills");
}

const samePath = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

async function requireNoLinks(directory: string, why: string): Promise<void> {
  const real = await fs.realpath(directory);
  if (!samePath(real, directory)) {
    throw new Error(
      `Refusing to write Hermes skills: ${why} resolves through a link (${directory} -> ${real}). `
      + "Point HERMES_HOME at the real directory.",
    );
  }
}

/**
 * Creates the skills directory only under a verified, link-free parent chain and returns it. Links in
 * any existing ancestor (symlink or Windows junction) are refused before anything is created, and the
 * result is checked again afterwards.
 */
async function ensureConfinedSkillsDir(skillsDir: string): Promise<string> {
  let existing = skillsDir;
  for (;;) {
    const info = await fs.lstat(existing).catch(() => null);
    if (info) break;
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  await requireNoLinks(existing, "the Hermes home");
  await fs.mkdir(skillsDir, { recursive: true });
  await requireNoLinks(skillsDir, "the Hermes skills directory");
  return skillsDir;
}

function requireSafeSkillName(name: string): string {
  if (!name || name === "." || name === ".." || path.basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error(`Refusing to link a Hermes skill with an unsafe name: ${JSON.stringify(name)}`);
  }
  return name;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const hermesSkillsHome = resolveHermesSkillsDir(config);

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function reconcileHermesPaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
  homeOptions: HermesHomeOptions = {},
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  // One verified directory for every write below; each write re-checks it, so a directory swapped for a
  // link between the check and the write is detected and its effect removed.
  const skillsHome = await ensureConfinedSkillsDir(resolveHermesSkillsDir(config, homeOptions));
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, requireSafeSkillName(entry.runtimeName));
    await ensurePaperclipSkillSymlink(entry.source, target);
    await verifyConfinedAfterWrite(skillsHome, target, entry.source);
    const linkedSource = await fs.readlink(target).catch(() => null);
    const resolvedSource = linkedSource
      ? path.resolve(path.dirname(target), linkedSource)
      : null;
    if (resolvedSource !== path.resolve(entry.source)) {
      throw new Error(
        `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
      );
    }
    // The preload only works when Hermes can open the skill through this link.
    if (!(await fs.stat(path.join(target, "SKILL.md")).catch(() => null))) {
      throw new Error(`Hermes skill "${entry.key}" is linked at ${target} but its SKILL.md cannot be read there.`);
    }
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await requireNoLinks(skillsHome, "the Hermes skills directory");
    await fs.unlink(path.join(skillsHome, requireSafeSkillName(name))).catch(() => {});
  }

  return desiredSkills;
}

/**
 * After a write, the directory must still be the verified one. If it was swapped for a link meanwhile,
 * the leaf was created somewhere else: remove that leaf (only if it is the link just made) and fail.
 */
async function verifyConfinedAfterWrite(skillsHome: string, target: string, source: string): Promise<void> {
  try {
    await requireNoLinks(skillsHome, "the Hermes skills directory");
  } catch (err) {
    const real = await fs.realpath(skillsHome).catch(() => null);
    if (real) {
      const stray = path.join(real, path.basename(target));
      const linked = await fs.readlink(stray).catch(() => null);
      if (linked && path.resolve(path.dirname(stray), linked) === path.resolve(source)) {
        await fs.unlink(stray).catch(() => undefined);
      }
    }
    throw err;
  }
}

/**
 * Runtime name of the operational Paperclip skill when it is among the reconciled skills, so the
 * adapter can preload it (`hermes chat -s <name>`). Loading it registers the variables its
 * frontmatter declares for Hermes' tool shell, which otherwise receives none of them.
 */
export async function resolveHermesOperationalSkillPreload(
  config: Record<string, unknown>,
  reconciledKeys: string[],
): Promise<string | null> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const entry = entries.find((candidate) => candidate.key.trim().toLowerCase() === PAPERCLIP_OPERATIONAL_SKILL_KEY);
  // An explicit opt-out is the only way to run Hermes without the operational skill.
  if (config.paperclipSkill === "disabled") return null;
  if (!entry) {
    throw new Error(
      `The operational Paperclip skill "${PAPERCLIP_OPERATIONAL_SKILL_KEY}" is absent from the runtime inventory; ` +
        "Hermes would start without the PAPERCLIP_* tool-shell variables, so the run was not started. " +
        'Set adapterConfig.paperclipSkill to "disabled" only for a run that must not use Paperclip.',
    );
  }
  // The skill is part of the inventory, so the run needs it: without the preload the tool shell
  // lacks every PAPERCLIP_* variable. Fail before Hermes starts instead of running without them.
  // A reconciled skill is already verified readable through its link by reconcileHermesPaperclipSkills.
  const reconciled = reconciledKeys.some((key) => key.trim().toLowerCase() === PAPERCLIP_OPERATIONAL_SKILL_KEY);
  const runtimeName = asString(entry.runtimeName);
  if (!reconciled || isPaperclipSkillSourceMissing(entry) || !runtimeName) {
    throw new Error(
      `The operational Paperclip skill "${entry.key}" is unavailable (source missing or not reconciled); ` +
        "Hermes would start without the PAPERCLIP_* tool-shell variables, so the run was not started.",
    );
  }
  return runtimeName;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesPaperclipSkills(ctx.config, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
