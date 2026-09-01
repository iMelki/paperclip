import type { Agent } from "@paperclipai/shared";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";

import { buildAgentUpdatePatch } from "./agent-config-patch";

export interface OnboardingAgentConfigReview {
  persistedAdapterType: string;
  persistedModel: string | null;
  adapterMatches: boolean;
  modelMatches: boolean;
  configMatches: boolean;
  matches: boolean;
}

export interface OnboardingAdapterConfigIntent {
  model?: boolean;
  url?: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSameAdapterOverlay(
  existingConfig: Record<string, unknown>,
  intendedConfig: Record<string, unknown>,
  intent: OnboardingAdapterConfigIntent,
) {
  const overlay: Record<string, unknown> = {};
  // Omitted wizard values mean preserve. Only an explicit interaction may
  // set or clear fields that the current onboarding UI actually exposes.
  if (intent.model) overlay.model = intendedConfig.model;
  if (intent.url) overlay.url = intendedConfig.url;

  if (isPlainRecord(intendedConfig.env)) {
    overlay.env = {
      ...(isPlainRecord(existingConfig.env) ? existingConfig.env : {}),
      ...intendedConfig.env,
    };
  }
  return overlay;
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizedJson(value[key])]),
  );
}

function adapterConfigsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right));
}

export function selectOnboardingAdapterModel(
  currentAdapterType: string,
  nextAdapterType: string,
  currentModel: string,
): string {
  if (currentAdapterType === nextAdapterType) return currentModel;
  if (nextAdapterType === "gemini_local") return DEFAULT_GEMINI_LOCAL_MODEL;
  if (nextAdapterType === "cursor") return DEFAULT_CURSOR_LOCAL_MODEL;
  if (nextAdapterType === "opencode_local") return DEFAULT_OPENCODE_LOCAL_MODEL;
  return "";
}

export function readAdapterModel(
  adapterConfig: Record<string, unknown>,
): string | null {
  const model = adapterConfig.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

export function buildOnboardingAgentUpdatePatch(
  agent: Agent,
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  intent: OnboardingAdapterConfigIntent = {},
) {
  const adapterChanged = agent.adapterType !== adapterType;
  const existingConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  return buildAgentUpdatePatch(agent, {
    identity: {},
    adapterType: adapterChanged ? adapterType : undefined,
    adapterConfig: adapterChanged
      ? adapterConfig
      : buildSameAdapterOverlay(existingConfig, adapterConfig, intent),
    heartbeat: {},
    runtime: {},
  });
}

export function reviewOnboardingAgentConfig(
  agent: Agent,
  intendedAdapterType: string,
  intendedAdapterConfig: Record<string, unknown>,
  exactAdapterConfig = false,
): OnboardingAgentConfigReview {
  const persistedAdapterType = agent.adapterType;
  const persistedModel = readAdapterModel(agent.adapterConfig);
  const intendedModel = readAdapterModel(intendedAdapterConfig);
  const adapterMatches = persistedAdapterType === intendedAdapterType;
  const modelMatches = persistedModel === intendedModel;
  const configMatches = !exactAdapterConfig
    || adapterConfigsEqual(agent.adapterConfig, intendedAdapterConfig);

  return {
    persistedAdapterType,
    persistedModel,
    adapterMatches,
    modelMatches,
    configMatches,
    matches: adapterMatches && modelMatches && configMatches,
  };
}
