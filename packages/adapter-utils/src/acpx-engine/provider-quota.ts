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
 * - "usage limit reached", "usage limit exceeded" (hyphen or space)
 * - "quota exceeded", "quota limit exceeded" (hyphen or space), unless the word
 *   before "quota" names a local resource (disk, storage, file, memory)
 *
 * A bare "usage limit" is not enough: it is a prefix of "usage limitations" and
 * appears in tool and API errors that are not the provider's session limit.
 *
 * A reset clock counts only inside the 120 characters after that statement,
 * and only for "resets", "resets at", or "try again at". The clock must carry
 * a real timezone (`(Asia/Jerusalem)`, `(UTC)`, or a bare `UTC`/`GMT`); a
 * whole hour with such a zone ("resets 9 (UTC)") is a clock. An
 * unparseable clock, a missing clock, or an unknown timezone leaves
 * `quotaResetAt` null. The classifier does not invent a zone or a time.
 */
export const ACPX_PROVIDER_QUOTA_ERROR_CODE = "acpx_provider_quota";

const ACPX_PROVIDER_QUOTA_STATEMENT_RE =
  /you(?:'|’)ve hit your (?:session|usage) limit\b|\busage[-\s]limit[-\s](?:reached|exceeded)\b|(?<!\b(?:disk|storage|file|filesystem|inode|memory|space)[-\s])\bquota(?:[-\s]limit)?[-\s]exceeded\b/i;

/** Same window the recovery classifier uses so a distant clock is not this statement's reset. */
const ACPX_PROVIDER_QUOTA_RESET_WINDOW_CHARS = 120;

/**
 * A clock that already passed by a few minutes (clock skew, a slow report) is
 * that clock, not tomorrow's. Anything older rolls to the next occurrence.
 */
const ACPX_PROVIDER_QUOTA_RESET_ELAPSED_GRACE_MS = 30 * 60 * 1000;

const ACPX_PROVIDER_QUOTA_CLOCK_RE =
  /\b(?:try again at|resets(?: at)?)\s+(\d{1,2})(?::(\d{2}))?(?![\d:])(?:\s*([ap])\.?\s*m\.?)?(?=(:?\d)?)(?:\s*\(([^)]+)\)|\s+(UTC|GMT)\b(?!\s*[-+−]\s*\d))?/gi;

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
  // The clock must start within the window after the statement, but it is
  // parsed whole: a timezone that ends past the window must not be cut off.
  const tail = message.slice(statement.index);
  const maxClockStart = statement[0].length + ACPX_PROVIDER_QUOTA_RESET_WINDOW_CHARS;
  const quotaResetAt = parseAcpxProviderQuotaReset(tail, now, maxClockStart);
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

function parseAcpxProviderQuotaReset(text: string, now: Date, maxClockStart: number): Date | null {
  const matches = text.matchAll(new RegExp(ACPX_PROVIDER_QUOTA_CLOCK_RE.source, "gi"));
  for (const match of matches) {
    if ((match.index ?? 0) > maxClockStart) break;
    // A bare "resets 7" is prose. A quota clock needs minutes, a meridiem, or an
    // explicit timezone ("resets 9 (UTC)"). A zone that is not real still
    // leaves the reset unparsed when it is resolved below.
    const clockLike =
      match[2] !== undefined || match[3] !== undefined || match[5] !== undefined || match[6] !== undefined;
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
    const wallClockMs = (date: Date) => {
      const parts = wallClock(date);
      return Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute),
      );
    };
    const buildResetAt = (dayOffset: number): Date | null => {
      const targetMs = Date.UTC(
        Number(nowParts.year), Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset, hour, minute,
      );
      // Sample offsets on both sides of the local date. A fall-back can repeat
      // a wall clock by 30 minutes, an hour, or another zone-specific amount.
      // Validate each candidate rather than assuming the size of the shift.
      const offsets = new Set<number>();
      for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
        const sample = new Date(targetMs + hours * 60 * 60 * 1000);
        offsets.add(wallClockMs(sample) - sample.getTime());
      }
      const candidates = [...offsets]
        .map((offset) => new Date(targetMs - offset))
        .filter((candidate) => wallClockMs(candidate) === targetMs)
        .sort((left, right) => left.getTime() - right.getTime());
      // Prefer an occurrence still ahead during an overlap, then allow the
      // recent-past grace only when no future occurrence remains today.
      return candidates.find((candidate) => candidate.getTime() >= now.getTime())
        ?? candidates.find((candidate) => candidate.getTime() >= base.getTime())
        ?? null;
    };
    return buildResetAt(0) ?? buildResetAt(1);
  } catch {
    return null;
  }
}
