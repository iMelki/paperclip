import { describe, expect, it } from "vitest";
import { exactTimestampRevision } from "../services/exact-timestamp-revision.js";

describe("exact connection timestamp representation", () => {
  const timestamp = "2026-10-13T01:02:03.123456Z";
  const observed = () => ({ updatedAt: new Date(timestamp), updatedAtExact: timestamp });

  it("retains all six native fractional digits", () => {
    expect(exactTimestampRevision(observed())).toBe(timestamp);
  });
  it("normalizes Date-only milliseconds to the same six-digit representation", () => {
    const updatedAt = new Date("2026-10-13T01:02:03.123Z");
    expect(exactTimestampRevision({ updatedAt })).toBe("2026-10-13T01:02:03.123000Z");
    expect(exactTimestampRevision({ updatedAt, updatedAtExact: "2026-10-13T01:02:03.123000Z" }))
      .toBe(exactTimestampRevision({ updatedAt }));
  });
  it("distinguishes one microsecond although both JavaScript dates look equal", () => {
    const next = { updatedAt: new Date("2026-10-13T01:02:03.123457Z"),
      updatedAtExact: "2026-10-13T01:02:03.123457Z" };
    expect(next.updatedAt.getTime()).toBe(observed().updatedAt.getTime());
    expect(exactTimestampRevision(next)).not.toBe(exactTimestampRevision(observed()));
  });
  it.each([null, "2026-10-13T01:02:03.123Z", "2026-10-13T01:02:03.123456+00:00",
    "2026-10-13T01:02:03.123456Z\n", "not-a-timestamp"])("refuses malformed captured value %s", value => {
    expect(() => exactTimestampRevision({ updatedAt: new Date(timestamp),
      updatedAtExact: value as unknown as string })).toThrow("Invalid exact connection timestamp observation");
  });
  it("refuses a raw token paired with a different projected Date", () => {
    expect(() => exactTimestampRevision({ updatedAt: new Date("2026-10-13T01:02:03.124Z"),
      updatedAtExact: timestamp })).toThrow("Invalid exact connection timestamp observation");
  });
  it("refuses an invalid Date even when a captured string is present", () => {
    expect(() => exactTimestampRevision({ updatedAt: new Date(NaN), updatedAtExact: timestamp }))
      .toThrow("Invalid connection timestamp observation");
  });
});
