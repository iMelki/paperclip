export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
  // Browser and proxy URL headers can repeat OAuth, reset, and signed-link
  // query values even after the request URL itself is normalized.
  "req.headers.referer",
  "req.headers.referrer",
  'req.headers["x-forwarded-uri"]',
  'req.headers["x-original-url"]',
  'req.headers["x-rewrite-url"]',
  "res.headers.location",
] as const;

// Static paths above only cover headers we know by name. Credential headers this
// server reads (x-openclaw-token, x-openclaw-auth, x-paperclip-cloud-tenant-token,
// x-paperclip-tool-gateway-token, x-paperclip-signature, x-hub-signature-256, ...)
// and any future ones are caught by a case-insensitive name rule instead.
const SENSITIVE_HTTP_HEADER_NAMES = new Set<string>([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "referer",
  "referrer",
  "x-forwarded-uri",
  "x-original-url",
  "x-rewrite-url",
  "location",
]);
const SENSITIVE_HTTP_HEADER_SEGMENT_RE =
  /(?:^|[-_])(?:token|auth|authorization|signature|secret|key|apikey|api[-_]key|password|passwd|credentials?|jwt|bearer|session|cookie)(?:$|[-_])/i;

export function isSensitiveHttpHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HTTP_HEADER_NAMES.has(normalized) || SENSITIVE_HTTP_HEADER_SEGMENT_RE.test(normalized);
}

export const REDACTED_HTTP_HEADER = "[Redacted]";

export function redactHttpHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = isSensitiveHttpHeaderName(name) ? REDACTED_HTTP_HEADER : value;
  }
  return out;
}

