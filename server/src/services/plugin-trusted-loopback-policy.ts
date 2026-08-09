/**
 * Host-owned policy for narrowly allowing plugin HTTP calls to local services.
 *
 * Loopback is denied by the normal plugin SSRF guard. Operators may opt a
 * company into exact HTTP method/origin/path rules stored under the reserved
 * `plugin_company_settings.settings_json.__paperclipHost` namespace. Plugins
 * can consume these rules through `ctx.http.fetch`, but cannot author them.
 */

export const PAPERCLIP_HOST_SETTINGS_KEY = "__paperclipHost";
export const TRUSTED_LOOPBACK_HTTP_RULES_KEY = "trustedLoopbackHttpRules";

const MAX_TRUSTED_LOOPBACK_HTTP_RULES = 100;
const HTTP_METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOOPBACK_ORIGIN_PATTERN =
  /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const LOOPBACK_URL_PREFIX_PATTERN =
  /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(?=\/|$)/;
const FORBIDDEN_ENCODED_PATH_COMPONENT = /%(?:2a|2e|2f|5c)/i;

export interface TrustedLoopbackHttpRule {
  method: string;
  origin: string;
  pathnamePattern: string;
}

export interface TrustedLoopbackFetchTarget {
  parsedUrl: URL;
  resolvedAddress: "127.0.0.1" | "::1";
  hostHeader: string;
  useTls: false;
}

export class TrustedLoopbackHttpPolicyError extends Error {
  readonly code = "invalid_trusted_loopback_http_policy";

  constructor(message: string) {
    super(message);
    this.name = "TrustedLoopbackHttpPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenEncodedPathComponent(value: string): boolean {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (FORBIDDEN_ENCODED_PATH_COMPONENT.test(current)) return true;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return false;
      current = decoded;
    } catch {
      throw new TrustedLoopbackHttpPolicyError("Loopback paths must use valid percent encoding");
    }
  }
  throw new TrustedLoopbackHttpPolicyError(
    "Loopback paths must not contain deeply nested percent encoding",
  );
}

function validatePathShape(value: string, label: string): string[] {
  if (!value.startsWith("/")) {
    throw new TrustedLoopbackHttpPolicyError(`${label} must start with "/"`);
  }
  if (value.includes("?") || value.includes("#")) {
    throw new TrustedLoopbackHttpPolicyError(`${label} must not contain a query string or fragment`);
  }
  if (value.includes("\\")) {
    throw new TrustedLoopbackHttpPolicyError(`${label} must not contain backslashes`);
  }
  if (hasForbiddenEncodedPathComponent(value)) {
    throw new TrustedLoopbackHttpPolicyError(
      `${label} must not contain encoded wildcards, dots, or path separators`,
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TrustedLoopbackHttpPolicyError(`${label} must use valid percent encoding`);
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TrustedLoopbackHttpPolicyError(`${label} must not contain dot segments`);
  }
  return segments;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || !LOOPBACK_ORIGIN_PATTERN.test(value)) {
    throw new TrustedLoopbackHttpPolicyError(
      'origin must be an exact "http://127.0.0.1:<port>" or "http://[::1]:<port>" literal',
    );
  }
  const port = Number(LOOPBACK_ORIGIN_PATTERN.exec(value)?.[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TrustedLoopbackHttpPolicyError("origin must contain an explicit valid TCP port");
  }
  return value;
}

function normalizeMethod(value: unknown): string {
  if (typeof value !== "string" || !HTTP_METHOD_TOKEN.test(value)) {
    throw new TrustedLoopbackHttpPolicyError("method must be a valid HTTP method token");
  }
  return value.toUpperCase();
}

function normalizePathnamePattern(value: unknown): string {
  if (typeof value !== "string") {
    throw new TrustedLoopbackHttpPolicyError("pathnamePattern must be a string");
  }
  const segments = validatePathShape(value, "pathnamePattern");
  const wildcardCount = segments.filter((segment) => segment === "*").length;
  if (segments.some((segment) => segment.includes("*") && segment !== "*")) {
    throw new TrustedLoopbackHttpPolicyError(
      'pathnamePattern wildcards must occupy a complete path segment ("*")',
    );
  }
  if (wildcardCount > 1) {
    throw new TrustedLoopbackHttpPolicyError(
      "pathnamePattern may contain at most one wildcard segment",
    );
  }
  return value;
}

export function parseTrustedLoopbackHttpRules(value: unknown): TrustedLoopbackHttpRule[] {
  if (!Array.isArray(value)) {
    throw new TrustedLoopbackHttpPolicyError("rules must be an array");
  }
  if (value.length > MAX_TRUSTED_LOOPBACK_HTTP_RULES) {
    throw new TrustedLoopbackHttpPolicyError(
      `rules must contain at most ${MAX_TRUSTED_LOOPBACK_HTTP_RULES} entries`,
    );
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TrustedLoopbackHttpPolicyError(`rules[${index}] must be an object`);
    }
    return {
      method: normalizeMethod(entry.method),
      origin: normalizeOrigin(entry.origin),
      pathnamePattern: normalizePathnamePattern(entry.pathnamePattern),
    };
  });
}

export function getTrustedLoopbackHttpRules(
  settingsJson: Record<string, unknown> | null | undefined,
): TrustedLoopbackHttpRule[] {
  if (!settingsJson) return [];
  const hostSettings = settingsJson[PAPERCLIP_HOST_SETTINGS_KEY];
  if (hostSettings === undefined) return [];
  if (!isRecord(hostSettings)) {
    throw new TrustedLoopbackHttpPolicyError(
      `${PAPERCLIP_HOST_SETTINGS_KEY} must be an object`,
    );
  }
  const rules = hostSettings[TRUSTED_LOOPBACK_HTTP_RULES_KEY];
  return rules === undefined ? [] : parseTrustedLoopbackHttpRules(rules);
}

export function setTrustedLoopbackHttpRules(
  settingsJson: Record<string, unknown> | null | undefined,
  rules: TrustedLoopbackHttpRule[],
): Record<string, unknown> {
  const current = settingsJson ?? {};
  const existingHostSettings = current[PAPERCLIP_HOST_SETTINGS_KEY];
  const hostSettings = isRecord(existingHostSettings) ? existingHostSettings : {};
  return {
    ...current,
    [PAPERCLIP_HOST_SETTINGS_KEY]: {
      ...hostSettings,
      [TRUSTED_LOOPBACK_HTTP_RULES_KEY]: rules,
    },
  };
}

function pathnameMatches(pattern: string, pathname: string): boolean {
  const patternSegments = decodeURIComponent(pattern).split("/");
  const pathnameSegments = decodeURIComponent(pathname).split("/");
  if (patternSegments.length !== pathnameSegments.length) return false;
  return patternSegments.every(
    (segment, index) =>
      segment === "*"
        ? (pathnameSegments[index]?.length ?? 0) > 0
        : segment === pathnameSegments[index],
  );
}

/**
 * Resolve an explicitly trusted loopback target. Non-loopback URLs return
 * `null` so the caller can apply the normal DNS-pinned SSRF guard unchanged.
 */
export function resolveTrustedLoopbackFetchTarget(input: {
  url: string;
  method?: string;
  rules: readonly TrustedLoopbackHttpRule[];
}): TrustedLoopbackFetchTarget | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    throw new TrustedLoopbackHttpPolicyError(`Invalid URL: ${input.url}`);
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLiteralLoopback = hostname === "127.0.0.1" || hostname === "[::1]";
  if (!isLiteralLoopback) return null;

  const prefix = LOOPBACK_URL_PREFIX_PATTERN.exec(input.url);
  if (!prefix) {
    throw new TrustedLoopbackHttpPolicyError(
      "Loopback URLs must use plain HTTP, a literal loopback address, and an explicit port",
    );
  }
  const port = Number(prefix[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TrustedLoopbackHttpPolicyError("Loopback URLs require a valid explicit TCP port");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new TrustedLoopbackHttpPolicyError("Loopback URLs must not contain credentials");
  }

  const rawPath = input.url.slice(prefix[0].length) || "/";
  validatePathShape(rawPath, "Loopback URL pathname");

  const origin = prefix[0];
  const method = normalizeMethod(input.method ?? "GET");
  const matched = input.rules.some((rule) =>
    rule.method === method
    && rule.origin === origin
    && pathnameMatches(rule.pathnamePattern, parsedUrl.pathname),
  );
  if (!matched) return null;

  return {
    parsedUrl,
    resolvedAddress: hostname === "127.0.0.1" ? "127.0.0.1" : "::1",
    hostHeader: parsedUrl.host,
    useTls: false,
  };
}
