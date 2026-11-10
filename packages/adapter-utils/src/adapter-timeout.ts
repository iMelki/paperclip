/**
 * Wall-clock timeout resolution for agent adapters.
 *
 * A missing, zero, or negative timeoutSec is not an unbounded run. It resolves
 * to the per-adapter default, unless PAPERCLIP_ADAPTER_TIMEOUT_SEC sets a
 * positive global default. A positive per-agent adapterConfig.timeoutSec
 * always wins.
 */

export const PAPERCLIP_ADAPTER_TIMEOUT_SEC_ENV = "PAPERCLIP_ADAPTER_TIMEOUT_SEC";

/**
 * Fallback when an adapter type has no entry of its own.
 * Matches the 4h sandbox backstop (DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC)
 * and the recovery watchdog critical threshold.
 */
export const DEFAULT_ADAPTER_TIMEOUT_SEC = 14_400;

export const PAPERCLIP_RUNNER_MIN_TIMEOUT_MS = 1_000;
export const PAPERCLIP_RUNNER_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/**
 * Per-adapter default timeoutSec. Positive adapterConfig.timeoutSec overrides
 * these. PAPERCLIP_ADAPTER_TIMEOUT_SEC overrides them when the agent value is
 * missing, 0, or negative.
 */
export const ADAPTER_DEFAULT_TIMEOUT_SEC = {
  /** Local coding CLIs. 4h matches the sandbox backstop so a local run has the same ceiling. */
  claude_local: 14_400,
  codex_local: 14_400,
  cursor: 14_400,
  gemini_local: 14_400,
  grok_local: 14_400,
  kimi_local: 14_400,
  opencode_local: 14_400,
  pi_local: 14_400,
  /** ACP engine used by the local coding adapters. Same ceiling as those CLIs. */
  acpx: 14_400,
  /** Cursor cloud runs have no child process; the SDK wait is raced against this. */
  cursor_cloud: 14_400,
  /** Hermes local already documented 30 minutes. Keep that default. */
  hermes_local: 1_800,
  /** Hermes gateway request timeout. Already 10 minutes. */
  hermes_gateway: 600,
  /** OpenClaw gateway RPC. The previous missing-value default was 2 minutes. */
  openclaw_gateway: 120,
  /** Arbitrary shell commands. 30 minutes covers batch scripts. */
  process: 1_800,
  /** HTTP webhook invoke. Fail in 2 minutes unless the agent sets a longer timeout. */
  http: 120,
  /** Native runner. The heartbeat already fell back to 1 hour, with a 24h cap. */
  paperclip_runner: 3_600,
} as const;

export type AdapterDefaultTimeoutKey = keyof typeof ADAPTER_DEFAULT_TIMEOUT_SEC;

export type AdapterTimeoutSource = "configured" | "env" | "adapter_default";

export interface AdapterTimeoutResolution {
  /** Always a finite number greater than 0. */
  timeoutSec: number;
  source: AdapterTimeoutSource;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function readPositiveTimeoutSec(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function readEnvTimeoutSec(env: EnvLike | undefined): number | null {
  if (!env) return null;
  return readPositiveTimeoutSec(env[PAPERCLIP_ADAPTER_TIMEOUT_SEC_ENV]);
}

export function resolveAdapterTimeoutSec(input: {
  configured: unknown;
  adapterDefaultSec: number;
  env?: EnvLike;
}): AdapterTimeoutResolution {
  const configured = readPositiveTimeoutSec(input.configured);
  if (configured != null) {
    return { timeoutSec: configured, source: "configured" };
  }
  const envTimeout = readEnvTimeoutSec(input.env ?? process.env);
  if (envTimeout != null) {
    return { timeoutSec: envTimeout, source: "env" };
  }
  const adapterDefault = readPositiveTimeoutSec(input.adapterDefaultSec);
  return {
    timeoutSec: adapterDefault ?? DEFAULT_ADAPTER_TIMEOUT_SEC,
    source: "adapter_default",
  };
}

export function adapterDefaultTimeoutSec(adapterType: string): number {
  if (Object.prototype.hasOwnProperty.call(ADAPTER_DEFAULT_TIMEOUT_SEC, adapterType)) {
    return ADAPTER_DEFAULT_TIMEOUT_SEC[adapterType as AdapterDefaultTimeoutKey];
  }
  return DEFAULT_ADAPTER_TIMEOUT_SEC;
}

export interface HttpAdapterTimeoutResolution {
  timeoutMs: number;
  source: AdapterTimeoutSource;
}

/**
 * HTTP adapters historically stored milliseconds in timeoutMs and documented
 * timeoutSec. A positive timeoutSec wins. A positive timeoutMs wins when
 * timeoutSec is missing, 0, or negative. Otherwise the env default or the
 * 120s adapter default applies.
 */
export function resolveHttpAdapterTimeout(input: {
  timeoutSec: unknown;
  timeoutMs: unknown;
  env?: EnvLike;
}): HttpAdapterTimeoutResolution {
  const timeoutSec = readPositiveTimeoutSec(input.timeoutSec);
  if (timeoutSec != null) {
    return { timeoutMs: timeoutSec * 1000, source: "configured" };
  }
  const timeoutMs = readPositiveTimeoutSec(input.timeoutMs);
  if (timeoutMs != null) {
    return { timeoutMs, source: "configured" };
  }
  const resolved = resolveAdapterTimeoutSec({
    configured: undefined,
    adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.http,
    env: input.env,
  });
  return { timeoutMs: resolved.timeoutSec * 1000, source: resolved.source };
}

/**
 * paperclip_runner's coordinator accepts only an integer timeout from 1s to 24h.
 * The resolved seconds are clamped into that window.
 */
export function resolvePaperclipRunnerTimeoutMs(input: {
  configured: unknown;
  env?: EnvLike;
}): number {
  const resolved = resolveAdapterTimeoutSec({
    configured: input.configured,
    adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.paperclip_runner,
    env: input.env,
  });
  const timeoutMs = Math.round(resolved.timeoutSec * 1_000);
  return Math.min(
    PAPERCLIP_RUNNER_MAX_TIMEOUT_MS,
    Math.max(PAPERCLIP_RUNNER_MIN_TIMEOUT_MS, timeoutMs),
  );
}
