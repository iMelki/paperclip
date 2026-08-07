import { createHash, timingSafeEqual } from "node:crypto";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function hashCoordinationLeaseToken(token: string): string {
  if (!token) throw new Error("Coordination lease token must not be empty");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyCoordinationLeaseToken(token: string, storedHash: string): boolean {
  if (!token || !SHA256_HEX_PATTERN.test(storedHash)) return false;
  const actual = Buffer.from(hashCoordinationLeaseToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return timingSafeEqual(actual, expected);
}
