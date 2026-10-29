// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

import { isSensitiveHttpHeaderName } from "./http-log-redaction.js";

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
  // The Claude setup-token login fields. `browserCode` carries the one-time
  // sign-in code and `authorization_code` carries the OAuth code; neither may
  // reach a log line.
  "browsercode",
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
  // The workspace login handoff ticket (PAP-17572). It is a signed bearer
  // credential carried as a query parameter, so it must never reach a log line
  // even though the exchange itself answers 302.
  "ticket",
]);

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
  // The Claude setup-token login URL. A structured `loginUrl` that reaches a log
  // sink keeps its origin and path only; the OAuth query, fragment, and any
  // credentials are stripped (SR-5 backstop).
  "loginurl",
  "login_url",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isUrlishKey(key: string): boolean {
  return URLISH_KEYS.has(key.toLowerCase());
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

// Header records shaped as { name, value } (for example tool
// transportConfig.headerPolicy.staticHeaders) keep the credential in `value`,
// which the per-key check above never flags. Mirrors the static header
// sensitivity rules in packages/shared validators/tool-access.ts.
const SENSITIVE_HEADER_NAMES = new Set<string>([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "x-paperclip-tool-gateway-token",
]);
const SENSITIVE_HEADER_NAME_RE =
  /(^|[-_])(access[-_]?key([-_]?id)?|api[-_]?key|auth|authorization|bearer|client[-_]?secret|cookie|credential(s)?|jwt|password|passwd|private[-_]?key|refresh[-_]?token|secret([-_]?access[-_]?key|[-_]?key)?|session([-_]?token)?|token)([-_]|$)/i;

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized)
    || SENSITIVE_HEADER_NAME_RE.test(normalized)
    || isSensitiveHttpHeaderName(normalized);
}

function isSensitiveHeaderRecord(record: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, "value")) return false;
  const name = record.name ?? record.header;
  return typeof name === "string" && isSensitiveHeaderName(name);
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
  const sensitiveHeaderRecord = isSensitiveHeaderRecord(record);
  for (const [key, entry] of Object.entries(record)) {
    if ((nonEmptyPlainBinding || sensitiveHeaderRecord) && key === "value") {
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
