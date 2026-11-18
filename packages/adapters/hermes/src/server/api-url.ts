/**
 * The Paperclip API URL an operator may configure for hermes_local.
 *
 * The URL receives authenticated requests that carry the run token, and the prompt prints it on
 * Hermes' command line. A configured override is therefore accepted only when it is a plain loopback
 * HTTP(S) origin with no credentials, query or fragment, and one validated value feeds both the
 * prompt and the child environment.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns the validated bare origin (for example `http://127.0.0.1:3100`, no `/api`), or `null` when
 * nothing is configured. The bare origin is what every other adapter puts in `PAPERCLIP_API_URL` and
 * what the shared skill builds its `/api/...` paths from, so the child variable stays an origin.
 * Throws on an unusable value. The message never repeats the URL, which may carry credentials.
 */
export function resolveConfiguredApiUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("hermes_local paperclipApiUrl is not a valid URL; use a loopback address such as http://127.0.0.1:3100");
  }
  const reject = (why: string): never => {
    throw new Error(`hermes_local paperclipApiUrl ${why}; use a loopback address such as http://127.0.0.1:3100`);
  };
  if (url.protocol !== "http:" && url.protocol !== "https:") reject("must use http or https");
  if (url.username || url.password) reject("must not contain credentials");
  if (url.search || url.hash) reject("must not contain a query or fragment");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) reject("must be a loopback address (localhost, 127.0.0.1 or [::1])");
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  if (trimmedPath !== "" && trimmedPath !== "/api") reject("must be the server root or end in /api");
  return url.origin;
}

/** The same origin with `/api`, for prompt text that shows the API base. */
export function apiBaseOf(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api`;
}
