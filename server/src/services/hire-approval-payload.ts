import { unprocessable } from "../errors.js";
import {
  REDACTED_EVENT_VALUE,
  redactEventPayload,
} from "../redaction.js";

const APPROVED_AGENT_PATCH_FIELDS = [
  "name",
  "role",
  "title",
  "icon",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
  "permissions",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactEmptyPlainBinding(value: unknown): value is { type: "plain"; value: "" } {
  return isPlainRecord(value) && value.type === "plain" && value.value === "";
}

function enforcePlainBindingRedaction(original: unknown, redacted: unknown): unknown {
  if (isPlainRecord(original) && original.type === "plain"
    && Object.prototype.hasOwnProperty.call(original, "value")) {
    const binding = isPlainRecord(redacted) ? { ...redacted } : { ...original };
    binding.value = isExactEmptyPlainBinding(original) ? "" : REDACTED_EVENT_VALUE;
    return binding;
  }
  if (Array.isArray(original) && Array.isArray(redacted)) {
    return redacted.map((value, index) =>
      enforcePlainBindingRedaction(original[index], value));
  }
  if (!isPlainRecord(original) || !isPlainRecord(redacted)) return redacted;

  const restored = { ...redacted };
  for (const [key, value] of Object.entries(original)) {
    if (!Object.prototype.hasOwnProperty.call(redacted, key)) continue;
    restored[key] = enforcePlainBindingRedaction(value, redacted[key]);
  }
  return restored;
}

function containsRedactedMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED_EVENT_VALUE);
  if (Array.isArray(value)) return value.some(containsRedactedMarker);
  if (!isPlainRecord(value)) return false;
  return Object.values(value).some(containsRedactedMarker);
}

function findRedactedMarkerPath(value: unknown, path: string): string | null {
  if (typeof value === "string" && value.includes(REDACTED_EVENT_VALUE)) return path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRedactedMarkerPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const found = findRedactedMarkerPath(nested, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function findAppliedAgentMarkerPath(payload: Record<string, unknown>): string | null {
  for (const field of APPROVED_AGENT_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const found = findRedactedMarkerPath(payload[field], field);
    if (found) return found;
  }
  return null;
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonEquivalent(left[key], right[key])
    ));
}

function assertRedactedValuesMatchPendingBaseline(
  redacted: unknown,
  normalized: unknown,
  baseline: unknown,
  path: string,
): void {
  if (redacted === REDACTED_EVENT_VALUE) {
    if (!jsonEquivalent(normalized, baseline)) {
      throw unprocessable("Hire approval secret differs from the pending-agent baseline", {
        code: "hire_approval_secret_baseline_mismatch",
        path,
      });
    }
    return;
  }
  if (Array.isArray(redacted)) {
    const normalizedArray = Array.isArray(normalized) ? normalized : [];
    const baselineArray = Array.isArray(baseline) ? baseline : [];
    redacted.forEach((value, index) => assertRedactedValuesMatchPendingBaseline(
      value,
      normalizedArray[index],
      baselineArray[index],
      `${path}[${index}]`,
    ));
    return;
  }
  if (!isPlainRecord(redacted)) return;
  const normalizedRecord = isPlainRecord(normalized) ? normalized : {};
  const baselineRecord = isPlainRecord(baseline) ? baseline : {};
  for (const [key, value] of Object.entries(redacted)) {
    assertRedactedValuesMatchPendingBaseline(
      value,
      normalizedRecord[key],
      baselineRecord[key],
      path ? `${path}.${key}` : key,
    );
  }
}

function restoreRedactedMarkers(candidate: unknown, baseline: unknown, path: string): unknown {
  if (candidate === REDACTED_EVENT_VALUE) {
    if (baseline === undefined || baseline === REDACTED_EVENT_VALUE) {
      throw unprocessable("Cannot restore redacted hire approval configuration", {
        code: "hire_approval_redacted_baseline_missing",
        path,
      });
    }
    return baseline;
  }

  if (Array.isArray(candidate)) {
    const baselineArray = Array.isArray(baseline) ? baseline : [];
    return candidate.map((value, index) =>
      restoreRedactedMarkers(value, baselineArray[index], `${path}[${index}]`));
  }

  if (!isPlainRecord(candidate)) return candidate;
  const baselineRecord = isPlainRecord(baseline) ? baseline : {};
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    restored[key] = restoreRedactedMarkers(value, baselineRecord[key], `${path}.${key}`);
  }
  return restored;
}

/**
 * Redact a pending-hire configuration before it is persisted in an approval.
 * An exactly empty plain binding is configuration, not secret material: it
 * explicitly selects the adapter's native authentication path. Whitespace and
 * every nonempty value stay redacted.
 */
export function redactHireApprovalConfigForPersistence(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactEventPayload(config) ?? {};
  return enforcePlainBindingRedaction(config, redacted) as Record<string, unknown>;
}

/**
 * Apply the same persistence redaction to the complete hire payload at every
 * ingress. This keeps audit-only duplicates such as requested snapshots from
 * becoming a second plaintext-secret store.
 */
export function redactHireApprovalPayloadForPersistence(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return redactHireApprovalConfigForPersistence(payload);
}

/**
 * Finish preparation after secret normalization. A pending-agent baseline
 * makes exact marker leaves recoverable at approval time. Without one, applied
 * fields must already be usable as persisted (empty bindings and secret refs
 * are safe; redaction markers are not).
 */
export function prepareNormalizedHireApprovalPayloadForPersistence(
  payload: Record<string, unknown>,
  pendingAgent?: Record<string, unknown> | null,
): Record<string, unknown> {
  const persisted = redactHireApprovalPayloadForPersistence(payload);
  if (pendingAgent) {
    for (const field of APPROVED_AGENT_PATCH_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(persisted, field)) continue;
      assertRedactedValuesMatchPendingBaseline(
        persisted[field],
        payload[field],
        pendingAgent[field],
        field,
      );
    }
    assertHireApprovalPayloadIsRestorable(persisted, pendingAgent);
    return persisted;
  }

  const markerPath = findAppliedAgentMarkerPath(persisted);
  if (markerPath) {
    throw unprocessable("Hire approval secret values require a pending-agent baseline", {
      code: "hire_approval_secret_baseline_required",
      path: markerPath,
    });
  }
  return persisted;
}

/**
 * Restore only applied agent fields, and only from the already-persisted
 * pending agent at the same field/path. Company and pending-state checks belong
 * to the caller because those facts are database state, not payload state.
 */
export function restoreHireApprovalPayloadFromPendingAgent(
  payload: Record<string, unknown>,
  pendingAgent: Record<string, unknown>,
): Record<string, unknown> {
  const restored = { ...payload };
  for (const field of APPROVED_AGENT_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    restored[field] = restoreRedactedMarkers(
      payload[field],
      pendingAgent[field],
      field,
    );
    if (containsRedactedMarker(restored[field])) {
      throw unprocessable("Cannot restore redacted hire approval configuration", {
        code: "hire_approval_redacted_baseline_missing",
        path: field,
      });
    }
  }
  return restored;
}

/**
 * Validate that every marker can be restored, then deliberately discard the
 * plaintext-bearing result so the persisted approval remains redacted at rest.
 */
function assertHireApprovalPayloadIsRestorable(
  payload: Record<string, unknown>,
  pendingAgent: Record<string, unknown>,
): void {
  restoreHireApprovalPayloadFromPendingAgent(payload, pendingAgent);
}
