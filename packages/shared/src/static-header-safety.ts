const HIGH_CONFIDENCE_STATIC_SECRET_PATTERNS = [
  /^(?:bearer|basic)\s+\S+/i,
  /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])sk_live_[A-Za-z0-9]{16,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?:$|[^A-Za-z0-9])/,
  /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|token)=\S+/i,
];

export function normalizeStaticHeaderValueForInspection(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, "");
}

export function hasInvalidStaticHeaderValueCharacters(value: string): boolean {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return true;
  }
  return false;
}

export function isHighConfidenceStaticSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeStaticHeaderValueForInspection(value);
  return HIGH_CONFIDENCE_STATIC_SECRET_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}
