const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

const SENSITIVE_REQUEST_BODY_PATHS = [
  /^\/api\/auth(?:\/|$)/i,
  /^\/api\/board-claim(?:\/|$)/i,
  /^\/api\/cli-auth(?:\/|$)/i,
  /\/(?:secrets?|user-secrets?|secret-proposals?|secret-provider-configs?)(?:\/|$)/i,
];

export function requestPathWithoutQuery(url: string | undefined): string {
  if (!url) return "";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export function requestPathForHttpLog(url: string | undefined): string {
  return requestPathWithoutQuery(url).replace(
    /^(\/api\/board-claim\/)[^/]+/i,
    "$1[REDACTED]",
  );
}

export function shouldOmitHttpRequestBody(url: string | undefined): boolean {
  const pathname = requestPathWithoutQuery(url);
  return SENSITIVE_REQUEST_BODY_PATHS.some((pattern) => pattern.test(pathname));
}

function normalizePath(url: string): string {
  const trimmed = requestPathWithoutQuery(url).trim();
  if (trimmed.length === 0) return "/";
  return trimmed;
}

export function shouldSilenceHttpSuccessLog(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
