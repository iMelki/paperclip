/**
 * ACPX turn failures that are a provider session limit or usage limit.
 *
 * The match is the provider's own limit statement. Bare "session limit" also
 * appears in tool, MCP, and terminal failures ("session limit reached (max 5
 * concurrent sessions)") and stays `acpx_turn_failed`.
 *
 * Accepted statements:
 * - "You've hit your session limit" / "You've hit your usage limit"
 *   (straight or curly apostrophe)
 * - "usage limit", "usage limit reached", "usage limit exceeded"
 *   (hyphen or space)
 * - "quota exceeded", "quota limit exceeded" (hyphen or space)
 *
 * A reset clock counts only inside the 120 characters after that statement,
 * and only for "resets", "resets at", or "try again at". The clock must carry
 * a real timezone (`(Asia/Jerusalem)`, `(UTC)`, or a bare `UTC`/`GMT`). An
 * unparseable clock, a missing clock, or an unknown timezone leaves
 * `quotaResetAt` null. The classifier does not invent a zone or a time.
 */
export const ACPX_PROVIDER_QUOTA_ERROR_CODE = "acpx_provider_quota";

const ACPX_PROVIDER_QUOTA_STATEMENT_RE =
  /you(?:'|’)ve hit your (?:session|usage) limit|usage[-\s]limit(?:[-\s](?:reached|exceeded))?|quota(?:[-\s]limit)?[-\s]exceeded/i;

/** Same window the recovery classifier uses so a distant clock is not this statement's reset. */
const ACPX_PROVIDER_QUOTA_RESET_WINDOW_CHARS = 120;

/**
 * A clock that already passed by a few minutes (clock skew, a slow report) is
 * that clock, not tomorrow's. Anything older rolls to the next occurrence.
 */
const ACPX_PROVIDER_QUOTA_RESET_ELAPSED_GRACE_MS = 30 * 60 * 1000;

const ACPX_PROVIDER_QUOTA_CLOCK_RE =
  /\b(?:try again at|resets(?: at)?)\s+(\d{1,2})(?::(\d{2}))?(?![\d:])(?:\s*([ap])\.?\s*m\.?)?(?=(:?\d)?)(?:\s*\(([^)]+)\)|\s+(UTC|GMT)\b)?/gi;

export type AcpxProviderQuotaTurnClassification = {
  errorCode: typeof ACPX_PROVIDER_QUOTA_ERROR_CODE;
  /** ISO-8601 reset instant, or null when the message has no parseable clock. */
  quotaResetAt: string | null;
};

export function classifyAcpxProviderQuotaTurn(
  message: string,
  now: Date = new Date(),
): AcpxProviderQuotaTurnClassification | null {
  const statement = ACPX_PROVIDER_QUOTA_STATEMENT_RE.exec(message);
  if (!statement || statement.index === undefined) return null;
  const windowEnd = statement.index + statement[0].length + ACPX_PROVIDER_QUOTA_RESET_WINDOW_CHARS;
  const window = message.slice(statement.index, windowEnd);
  const quotaResetAt = parseAcpxProviderQuotaReset(window, now);
  return {
    errorCode: ACPX_PROVIDER_QUOTA_ERROR_CODE,
    quotaResetAt: quotaResetAt ? quotaResetAt.toISOString() : null,
  };
}

/**
 * First matching text wins, except a later text that actually parses a reset
 * replaces an earlier quota statement that had no clock.
 */
export function classifyAcpxProviderQuotaTurnFromTexts(
  texts: Array<string | null | undefined>,
  now: Date = new Date(),
): AcpxProviderQuotaTurnClassification | null {
  let match: AcpxProviderQuotaTurnClassification | null = null;
  for (const text of texts) {
    if (!text) continue;
    const next = classifyAcpxProviderQuotaTurn(text, now);
    if (!next) continue;
    if (!match || (match.quotaResetAt == null && next.quotaResetAt != null)) match = next;
  }
  return match;
}

function readClockZone(match: RegExpMatchArray): string | null {
  const parenthesized = match[5]?.trim();
  if (parenthesized) return canonicalizeQuotaTimeZone(parenthesized);
  const bare = match[6]?.trim();
  if (!bare) return null;
  return canonicalizeQuotaTimeZone(bare);
}

function canonicalizeQuotaTimeZone(zone: string): string | null {
  if (/^(?:UTC|GMT)$/i.test(zone)) return zone.toUpperCase();
  return zone;
}

function parseAcpxProviderQuotaReset(window: string, now: Date): Date | null {
  const matches = window.matchAll(new RegExp(ACPX_PROVIDER_QUOTA_CLOCK_RE.source, "gi"));
  for (const match of matches) {
    // A bare "resets 7" is prose. A quota clock needs minutes, a meridiem, or both.
    const clockLike = match[2] !== undefined || match[3] !== undefined;
    if (!clockLike) continue;
    const resolved = resolveAcpxProviderQuotaClock(match, now);
    if (resolved) return resolved;
  }
  return null;
}

function resolveAcpxProviderQuotaClock(match: RegExpMatchArray, now: Date): Date | null {
  // A digit or ":digit" glued to the clock ("9:00pm:30") is not a clock.
  if (match[4] !== undefined) return null;
  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;

  const timeZone = readClockZone(match);
  // No timezone means the absolute instant is not known. Leave it unparsed.
  if (!timeZone) return null;

  const base = new Date(now.getTime() - ACPX_PROVIDER_QUOTA_RESET_ELAPSED_GRACE_MS);
  try {
    const wallClock = (date: Date) => Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const nowParts = wallClock(base);
    const buildResetAt = (dayOffset: number) => {
      const targetDay = new Date(Date.UTC(
        Number(nowParts.year),
        Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset,
        hour,
        minute,
      ));
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildResetAt(0);
    return sameDay.getTime() >= base.getTime() ? sameDay : buildResetAt(1);
  } catch {
    return null;
  }
}
