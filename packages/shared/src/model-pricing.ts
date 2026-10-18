/**
 * API-equivalent cost estimates from token counts.
 *
 * Subscription-billed runs (`billing_type = 'subscription_included'`, e.g.
 * Claude Code on a Max plan or Codex on a ChatGPT plan) report token usage but
 * no dollar cost, and `normalizeBilledCostCents` books them at 0 cents. That is
 * correct for the ledger (nobody is invoiced per run) but leaves operators with
 * a permanent $0.00. This module prices those tokens at published API list
 * rates so the UI can show what the same work would have cost on metered API
 * billing. The result is always an ESTIMATE: it is computed at read time, never
 * written to `cost_events.cost_cents`, and never feeds budget enforcement.
 *
 * Rates are USD per 1M tokens. Cache writes are not tracked separately in the
 * ledger, so they are priced as fresh input (a slight under-estimate).
 * Only listed model ids (plus dated snapshots and provider/region wrappers of
 * them) are priced; any other id, including an unlisted point release or
 * variant of a listed family, returns `null` (unpriced) rather than a guess.
 */

export interface ModelTokenRate {
  /** USD per 1M non-cached input tokens. */
  input: number;
  /** USD per 1M cache-read input tokens. */
  cachedInput: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface ModelPricingTable {
  /** Date the rates were last checked against the provider pricing pages. */
  asOf: string;
  sources: string[];
  /** Rates keyed by exact (normalized) model id. */
  rates: Record<string, ModelTokenRate>;
}

export const MODEL_PRICING: ModelPricingTable = {
  asOf: "2026-10-11",
  sources: ["https://www.anthropic.com/pricing", "https://openai.com/api/pricing"],
  rates: {
    // Anthropic, current generation
    "claude-fable-5-1": { input: 10, cachedInput: 0.25, output: 50 },
    "claude-mythos-5-1": { input: 10, cachedInput: 0.25, output: 50 },
    "claude-fable-5": { input: 10, cachedInput: 1, output: 50 },
    "claude-mythos-5": { input: 10, cachedInput: 1, output: 50 },
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, output: 20 },
    "claude-opus-5": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
    "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 },
    "claude-haiku-5-5": { input: 0.1, cachedInput: 0.01, output: 0.5 },
    // Anthropic, 4.x
    "claude-opus-4-8": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-7": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-6": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-5": { input: 5, cachedInput: 0.5, output: 25 },
    "claude-opus-4-1": { input: 15, cachedInput: 1.5, output: 75 },
    "claude-opus-4": { input: 15, cachedInput: 1.5, output: 75 },
    "claude-opus-4-0": { input: 15, cachedInput: 1.5, output: 75 },
    "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-sonnet-4-5": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-sonnet-4": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-sonnet-4-0": { input: 3, cachedInput: 0.3, output: 15 },
    "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5 },
    // Claude Code model aliases resolve to the current generation.
    opus: { input: 4, cachedInput: 0.2, output: 20 },
    sonnet: { input: 2, cachedInput: 0.2, output: 10 },
    haiku: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    // OpenAI GPT-5 family (as used by Codex). Later point releases are
    // deliberately absent until their rates are verified.
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
    "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
    "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5.1-codex-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  },
};

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Reduce a provider model id to the form the pricing table is keyed by:
 * lower-case, without a Bedrock/Vertex region prefix ("us.anthropic."), a
 * provider prefix ("anthropic/", "openai/"), or a context suffix ("[1m]").
 */
export function normalizePricingModelId(model: string | null | undefined): string {
  let key = (model ?? "").trim().toLowerCase();
  key = key.replace(/\[[^\]]*\]$/, "");
  // Bedrock version suffix: "anthropic.claude-sonnet-4-5-20250929-v1:0".
  key = key.replace(/-v\d+(?::\d+)?$/, "");
  const slash = key.lastIndexOf("/");
  if (slash >= 0) key = key.slice(slash + 1);
  const claudeAt = key.indexOf("claude-");
  if (claudeAt > 0) key = key.slice(claudeAt);
  return key.replace(/@.*$/, "");
}

// Dated snapshot suffixes: "-20250929" (Anthropic) or "-2025-08-07" (OpenAI).
const DATED_SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

export function resolveModelTokenRate(
  model: string | null | undefined,
  table: ModelPricingTable = MODEL_PRICING,
): ModelTokenRate | null {
  const key = normalizePricingModelId(model);
  if (!key || key === "unknown") return null;
  // Exact ids only. A prefix rule would price "gpt-5.1.999" as gpt-5.1 or
  // "claude-opus-4-99" as claude-opus-4; an unlisted variant stays unpriced.
  return table.rates[key] ?? table.rates[key.replace(DATED_SNAPSHOT_SUFFIX, "")] ?? null;
}

/**
 * Adapter types whose `inputTokens` already include the cache reads reported
 * in `cachedInputTokens` (Codex `turn.completed.usage.input_tokens`, see
 * packages/adapters/codex-local/src/server/parse.ts). Every other producer
 * reports input exclusive of cache (Claude `input_tokens` vs
 * `cache_read_input_tokens`), so cache must never be subtracted globally.
 */
export const INPUT_INCLUDES_CACHED_ADAPTER_TYPES: ReadonlySet<string> = new Set(["codex_local"]);

/**
 * Ledger token counts in one convention: `inputTokens` = fresh (non-cached)
 * input. Apply before pricing or summing so cache reads are not counted twice.
 */
export function toExclusiveTokenCounts(adapterType: string | null | undefined, usage: TokenCounts): TokenCounts {
  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens || 0);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  if (!adapterType || !INPUT_INCLUDES_CACHED_ADAPTER_TYPES.has(adapterType)) {
    return { inputTokens, cachedInputTokens, outputTokens };
  }
  return { inputTokens: Math.max(0, inputTokens - cachedInputTokens), cachedInputTokens, outputTokens };
}

/**
 * Estimated API-equivalent cost in cents, or `null` when the model has no
 * known rate. Fractional cents are kept so many small runs sum correctly;
 * round only for display.
 */
export function estimateTokenCostCents(
  model: string | null | undefined,
  usage: TokenCounts,
  table: ModelPricingTable = MODEL_PRICING,
): number | null {
  const input = Math.max(0, usage.inputTokens || 0);
  const cached = Math.max(0, usage.cachedInputTokens || 0);
  const output = Math.max(0, usage.outputTokens || 0);
  if (input === 0 && cached === 0 && output === 0) return 0;
  const rate = resolveModelTokenRate(model, table);
  if (!rate) return null;
  const usd = (input * rate.input + cached * rate.cachedInput + output * rate.output) / 1_000_000;
  return usd * 100;
}
