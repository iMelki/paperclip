export interface ExactTimestampRevision {
  updatedAt: Date;
  /** Internal native SQL observation; never copied from worker/browser input. */
  updatedAtExact?: string;
}

/** Preserve the native microsecond instant; Date-only rows retain strict old CAS semantics. */
export function exactTimestampRevision(row: ExactTimestampRevision): string {
  const dateMs = row.updatedAt.getTime();
  if (!Number.isFinite(dateMs)) throw new Error("Invalid connection timestamp observation");
  if (row.updatedAtExact !== undefined) {
    if (typeof row.updatedAtExact !== "string"
      || row.updatedAtExact.length !== 27
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.updatedAtExact)
      || Date.parse(row.updatedAtExact) !== dateMs) {
      throw new Error("Invalid exact connection timestamp observation");
    }
    return row.updatedAtExact;
  }
  // This is not a microsecond reconstruction: it means exactly the old Date instant.
  // A DB row with a different sub-millisecond remainder still does not match this value.
  return row.updatedAt.toISOString().slice(0, -1) + "000Z";
}
