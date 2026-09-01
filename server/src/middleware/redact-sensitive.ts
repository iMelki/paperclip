// Redaction for HTTP log payloads.
//
// The response-time context in http-logger.ts can copy `req.body` / `req.params` into
// 4xx/5xx log lines so operators can diagnose. Query objects are omitted and
// credential-bearing routes omit the complete body; this walker is the second
// layer for ordinary routes. Without it,
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
  "code",
  "authorization_code",
  "authorizationcode",
  "verification_code",
  "verificationcode",
  "security_code",
  "securitycode",
  "otp",
  "one_time_password",
  "onetimepassword",
  "passcode",
  "pin",
  "state",
]);
const SENSITIVE_KEY_SEGMENT_RE =
  /(?:^|[_-])(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connection[-_]?string)(?:$|[_-])/i;
const NON_SENSITIVE_METRIC_KEYS = new Set(["token_count", "token_limit"]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const URLISH_KEYS = new Set<string>([
  "href",
  "locator",
  "source",
  "source_locator",
  "sourcelocator",
  "source_url",
  "sourceurl",
  "uri",
  "url",
]);

function normalizePayloadKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizePayloadKey(key);
  if (NON_SENSITIVE_METRIC_KEYS.has(normalized)) return false;
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_SEGMENT_RE.test(normalized);
}

function isUrlishKey(key: string): boolean {
  const normalized = normalizePayloadKey(key);
  return URLISH_KEYS.has(normalized) || /(?:^|_)(?:url|uri)$/.test(normalized);
}

function stripSecretBearingUrlParts(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  const nonEmptyPlainBinding = record.type === "plain"
    && Object.prototype.hasOwnProperty.call(record, "value")
    && record.value !== "";
  for (const [key, entry] of Object.entries(record)) {
    if (nonEmptyPlainBinding && key === "value") {
      out[key] = REDACTED;
      continue;
    }
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof entry === "string" && isUrlishKey(key)) {
      out[key] = stripSecretBearingUrlParts(entry);
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}
