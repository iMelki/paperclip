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
