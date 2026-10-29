import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VALID_PROVIDERS } from "../shared/constants.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
const PORTABLE_ENV = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"];

export interface StrictHermesIsolation {
  root: string;
  profile: string;
  paperclipApiUrl: string;
  timeoutSec: number;
  maxTurns: number;
  env: Record<string, string>;
}

/** A source-level launch boundary, not proof of Hermes's effective credential resolution. */
export async function resolveStrictHermesIsolation(
  config: Record<string, unknown>,
  parentEnv: NodeJS.ProcessEnv = process.env,
  hostHomePath: string = os.homedir(),
): Promise<StrictHermesIsolation> {
  const rawRoot = config.hermesHome;
  const profile = config.hermesProfile;
  if (typeof rawRoot !== "string" || !path.isAbsolute(rawRoot)) {
    throw new Error("Strict Hermes isolation requires an absolute hermesHome");
  }
  if (typeof profile !== "string" || profile === "default" || !PROFILE_ID.test(profile)) {
    throw new Error("Strict Hermes isolation requires a valid named hermesProfile");
  }
  const command = config.hermesCommand ?? config.command;
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    throw new Error("Strict Hermes isolation requires an absolute Hermes command path");
  }
  let paperclipApiUrl: URL;
  try {
    paperclipApiUrl = new URL(String(config.paperclipApiUrl));
  } catch {
    throw new Error("Strict Hermes isolation requires an explicit Paperclip API URL");
  }
  if (!["http:", "https:"].includes(paperclipApiUrl.protocol) || paperclipApiUrl.username ||
      paperclipApiUrl.password || paperclipApiUrl.search || paperclipApiUrl.hash ||
      paperclipApiUrl.pathname !== "/api") {
    throw new Error("Strict Hermes isolation rejects a credential-bearing or non-HTTP API URL");
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(paperclipApiUrl.hostname.toLowerCase())) {
    throw new Error("Strict Hermes isolation requires a loopback Paperclip API URL");
  }
  if (config.env && Object.keys(config.env as object).length > 0) {
    throw new Error("Strict Hermes isolation forbids adapter env overrides");
  }
  if (Array.isArray(config.extraArgs) && config.extraArgs.length > 0) {
    throw new Error("Strict Hermes isolation forbids extraArgs");
  }
  if (config.persistSession !== false) {
    throw new Error("Strict Hermes isolation requires persistSession=false");
  }
  if (typeof config.model !== "string" || !config.model.trim() || config.model === "auto" ||
      typeof config.provider !== "string" || config.provider === "auto" ||
      !(VALID_PROVIDERS as readonly string[]).includes(config.provider)) {
    throw new Error("Strict Hermes isolation requires explicit model and provider");
  }
  const timeoutSec = config.timeoutSec;
  const maxTurns = config.maxTurnsPerRun;
  if (!Number.isInteger(timeoutSec) || (timeoutSec as number) < 1 || (timeoutSec as number) > 900 ||
      !Number.isInteger(maxTurns) || (maxTurns as number) < 1 || (maxTurns as number) > 3) {
    throw new Error("Strict Hermes isolation requires 1-900 timeout seconds and 1-3 turns");
  }

  const root = await fs.realpath(rawRoot);
  const commandInfo = await fs.stat(command).catch(() => null);
  if (!commandInfo?.isFile()) throw new Error("Strict Hermes isolation requires an existing command file");
  const hostHome = await fs.realpath(hostHomePath);
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const isWithin = (child: string, parent: string) => {
    const relative = path.relative(normalized(parent), normalized(child));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  };
  if (isWithin(hostHome, root)) {
    throw new Error("Strict Hermes isolation cannot use the host user home or its ancestor");
  }
  const forbiddenRoots = [
    path.join(hostHome, ".hermes"),
    parentEnv.LOCALAPPDATA ? path.join(parentEnv.LOCALAPPDATA, "Hermes") : "",
    parentEnv.HERMES_HOME ?? "",
  ].filter(Boolean);
  for (const forbidden of forbiddenRoots) {
    const knownRoot = await fs.realpath(forbidden).catch(() => "");
    if (knownRoot && (isWithin(root, knownRoot) || isWithin(knownRoot, root))) {
      throw new Error("Strict Hermes isolation cannot reuse a host Hermes home");
    }
  }
  const profileDir = path.join(root, "profiles", profile);
  const actualProfileDir = await fs.realpath(profileDir);
  if (normalized(actualProfileDir) !== normalized(profileDir)) {
    throw new Error("Strict Hermes isolation rejects a relocated or linked profile directory");
  }
  let identified = false;
  for (const marker of PROFILE_MARKERS) {
    const info = await fs.lstat(path.join(profileDir, marker)).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error("Strict Hermes isolation rejects linked profile identity files");
    if (info?.isFile()) identified = true;
  }
  if (!identified) throw new Error("Strict Hermes isolation requires an existing named profile");

  const env: Record<string, string> = {};
  for (const key of PORTABLE_ENV) {
    if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
  }
  env.HOME = root;
  env.USERPROFILE = root;
  env.APPDATA = path.join(root, "appdata");
  env.LOCALAPPDATA = path.join(root, "localappdata");
  env.XDG_CONFIG_HOME = path.join(root, "xdg-config");
  env.XDG_CACHE_HOME = path.join(root, "xdg-cache");
  env.XDG_DATA_HOME = path.join(root, "xdg-data");
  env.HERMES_HOME = root;
  return {
    root, profile, paperclipApiUrl: paperclipApiUrl.toString(),
    timeoutSec: timeoutSec as number, maxTurns: maxTurns as number, env,
  };
}
