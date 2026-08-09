import {
  hasInvalidStaticHeaderValueCharacters,
  isHighConfidenceStaticSecretValue,
  normalizeStaticHeaderValueForInspection,
} from "@paperclipai/shared";

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const RESERVED_PROTOCOL_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SENSITIVE_PASSTHROUGH_HEADER_PATTERN =
  /(^|[-_])(access[-_]?key([-_]?id)?|api[-_]?key|auth|authorization|bearer|client[-_]?secret|cookie|credential(s)?|jwt|password|passwd|private[-_]?key|refresh[-_]?token|secret([-_]?access[-_]?key|[-_]?key)?|session([-_]?token)?|token)([-_]|$)/i;

const SENSITIVE_PASSTHROUGH_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-paperclip-tool-gateway-token",
]);

export const REMOTE_MCP_METADATA_HEADER_KEYS = [
  "company_id",
  "agent_id",
  "issue_id",
  "project_id",
  "run_id",
  "gateway_session_id",
  "correlation_id",
] as const;

export type RemoteMcpMetadataHeaderKey = (typeof REMOTE_MCP_METADATA_HEADER_KEYS)[number];

export type RemoteMcpHeaderPolicy = {
  version: 1;
  staticHeaders: Array<{ name: string; value: string }>;
  passthroughAllowlist: string[];
  metadataHeaders: RemoteMcpMetadataHeaderKey[];
};

export type RemoteMcpHeaderSummary = {
  staticHeaderNames: string[];
  credentialHeaderNames: string[];
  passthroughHeaderNames: string[];
  droppedPassthroughHeaderNames: string[];
  metadataHeaderNames: string[];
  collisionRules: Array<{ header: string; source: string; action: string }>;
};

export type RemoteMcpHeaderPolicySource = {
  config?: unknown;
  transportConfig?: unknown;
};

export class RemoteMcpHeaderValidationError extends Error {
  readonly code = "remote_mcp_header_policy_invalid";

  constructor(
    message: string,
    public readonly reason:
      | "invalid_policy"
      | "invalid_static_headers"
      | "invalid_header_name"
      | "invalid_header_value"
      | "invalid_passthrough_allowlist"
      | "invalid_metadata_headers"
      | "sensitive_static_header",
  ) {
    super(message);
    this.name = "RemoteMcpHeaderValidationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizedHeaderName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header policy contains an invalid header name.",
      "invalid_header_name",
    );
  }
  const trimmed = value.trim();
  if (!HEADER_NAME_PATTERN.test(trimmed)) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header policy contains an invalid header name.",
      "invalid_header_name",
    );
  }
  return trimmed.toLowerCase();
}

function normalizedHeaderValue(value: unknown): string {
  if (
    typeof value !== "string"
    || hasInvalidStaticHeaderValueCharacters(value)
  ) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header values must be strings without control characters.",
      "invalid_header_value",
    );
  }
  return value;
}

function normalizedStaticHeaderValue(value: unknown): string {
  const normalized = normalizeStaticHeaderValueForInspection(
    normalizedHeaderValue(value),
  );
  if (isHighConfidenceStaticSecretValue(normalized)) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP static headers cannot contain credentials or other sensitive authority.",
      "sensitive_static_header",
    );
  }
  return normalized;
}

function isSensitivePassthroughHeader(name: string): boolean {
  const compactName = name.replace(/[-_]/g, "");
  const compactSensitive = [
    "accesskey",
    "apikey",
    "authorization",
    "bearer",
    "clientsecret",
    "cookie",
    "credential",
    "jwt",
    "password",
    "privatekey",
    "refreshtoken",
    "secret",
    "token",
  ];
  return name.startsWith("x-paperclip-")
    || SENSITIVE_PASSTHROUGH_HEADER_NAMES.has(name)
    || SENSITIVE_PASSTHROUGH_HEADER_PATTERN.test(name)
    || compactSensitive.some((term) => compactName.includes(term));
}

function isReservedProtocolHeader(name: string): boolean {
  return RESERVED_PROTOCOL_HEADERS.has(name) || name.startsWith("proxy-");
}

function normalizedStaticHeaderName(value: unknown): string {
  const name = normalizedHeaderName(value);
  if (isSensitivePassthroughHeader(name)) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP static headers cannot contain credentials or other sensitive authority.",
      "sensitive_static_header",
    );
  }
  return name;
}

function readHeaderNameArray(
  value: unknown,
  reason: "invalid_passthrough_allowlist" | "invalid_metadata_headers",
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RemoteMcpHeaderValidationError(
      reason === "invalid_passthrough_allowlist"
        ? "Remote MCP header passthrough allowlists must be arrays of header names."
        : "Remote MCP metadata header configuration must be an array of supported keys.",
      reason,
    );
  }
  return value.map(normalizedHeaderName);
}

function readStaticHeaders(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined || value === null) return [];
  const parsed: Array<{ name: string; value: string }> = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record || !Object.hasOwn(record, "name") || !Object.hasOwn(record, "value")) {
        throw new RemoteMcpHeaderValidationError(
          "Remote MCP static headers must contain name and value fields.",
          "invalid_static_headers",
        );
      }
      parsed.push({
        name: normalizedStaticHeaderName(record.name),
        value: normalizedStaticHeaderValue(record.value),
      });
    }
    return parsed;
  }
  const record = asRecord(value);
  if (!record) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP static headers must be an object or an array.",
      "invalid_static_headers",
    );
  }
  for (const [name, headerValue] of Object.entries(record)) {
    parsed.push({
      name: normalizedStaticHeaderName(name),
      value: normalizedStaticHeaderValue(headerValue),
    });
  }
  return parsed;
}

function rawHeaderPolicy(source: RemoteMcpHeaderPolicySource): unknown {
  const config = asRecord(source.config);
  if (
    config
    && Object.hasOwn(config, "headerPolicy")
    && config.headerPolicy !== undefined
    && config.headerPolicy !== null
  ) {
    return config.headerPolicy;
  }
  const transportConfig = asRecord(source.transportConfig);
  return transportConfig?.headerPolicy;
}

export function readRemoteMcpHeaderPolicy(source: RemoteMcpHeaderPolicySource): RemoteMcpHeaderPolicy {
  const raw = rawHeaderPolicy(source);
  if (raw === undefined || raw === null) {
    return { version: 1, staticHeaders: [], passthroughAllowlist: [], metadataHeaders: [] };
  }
  const policy = asRecord(raw);
  if (!policy) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header policy must be an object.",
      "invalid_policy",
    );
  }
  if (Object.hasOwn(policy, "version") && policy.version !== 1) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header policy uses an unsupported version.",
      "invalid_policy",
    );
  }

  const passthrough = asRecord(policy.passthrough);
  if (policy.passthrough !== undefined && policy.passthrough !== null && !passthrough) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP header passthrough policy must be an object.",
      "invalid_passthrough_allowlist",
    );
  }
  const passthroughAllowlist = [
    ...readHeaderNameArray(passthrough?.allow, "invalid_passthrough_allowlist"),
    ...readHeaderNameArray(passthrough?.allowedHeaders, "invalid_passthrough_allowlist"),
    ...readHeaderNameArray(policy.allowedPassthroughHeaders, "invalid_passthrough_allowlist"),
  ].filter((name) => !isSensitivePassthroughHeader(name));

  const metadata = asRecord(policy.metadata);
  if (policy.metadata !== undefined && policy.metadata !== null && !metadata) {
    throw new RemoteMcpHeaderValidationError(
      "Remote MCP metadata header policy must be an object.",
      "invalid_metadata_headers",
    );
  }
  const metadataHeaders = [
    ...readHeaderNameArray(metadata?.forward, "invalid_metadata_headers"),
    ...readHeaderNameArray(metadata?.headers, "invalid_metadata_headers"),
    ...readHeaderNameArray(policy.forwardContextHeaders, "invalid_metadata_headers"),
  ].map((value) => {
    const key = value.replace(/-/g, "_");
    if (!(REMOTE_MCP_METADATA_HEADER_KEYS as readonly string[]).includes(key)) {
      throw new RemoteMcpHeaderValidationError(
        "Remote MCP metadata header configuration contains an unsupported key.",
        "invalid_metadata_headers",
      );
    }
    return key as RemoteMcpMetadataHeaderKey;
  });

  return {
    version: 1,
    staticHeaders: readStaticHeaders(policy.staticHeaders),
    passthroughAllowlist: [...new Set(passthroughAllowlist)],
    metadataHeaders: [...new Set(metadataHeaders)],
  };
}

function normalizeHeaderRecord(
  input: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    if (rawValue === undefined) continue;
    const name = normalizedHeaderName(rawName);
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers[name] = normalizedHeaderValue(value);
  }
  return headers;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildRemoteMcpHeaders(input: {
  connection: RemoteMcpHeaderPolicySource;
  credentialHeaders?: Record<string, string>;
  callerHeaders?: Record<string, string | string[] | undefined>;
  metadataValues?: Partial<Record<RemoteMcpMetadataHeaderKey, string | null | undefined>>;
  preserveCredentialHeaderCase?: boolean;
}): { headers: Record<string, string>; summary: RemoteMcpHeaderSummary } {
  const policy = readRemoteMcpHeaderPolicy(input.connection);
  const callerHeaders = normalizeHeaderRecord(input.callerHeaders);
  const credentialHeaders = normalizeHeaderRecord(input.credentialHeaders);
  const credentialOutputNames = new Map<string, string>();
  for (const name of Object.keys(input.credentialHeaders ?? {})) {
    credentialOutputNames.set(normalizedHeaderName(name), name.trim());
  }
  const managedCredentialHeaders = new Set(Object.keys(credentialHeaders));
  const headers: Record<string, string> = {};
  const summary: RemoteMcpHeaderSummary = {
    staticHeaderNames: [],
    credentialHeaderNames: Object.keys(credentialHeaders),
    passthroughHeaderNames: [],
    droppedPassthroughHeaderNames: [],
    metadataHeaderNames: [],
    collisionRules: [],
  };

  for (const [name, value] of Object.entries(callerHeaders)) {
    if (isReservedProtocolHeader(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({ header: name, source: "caller", action: "dropped_reserved_header" });
      continue;
    }
    if (managedCredentialHeaders.has(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({ header: name, source: "caller", action: "kept_managed_credential" });
      continue;
    }
    if (isSensitivePassthroughHeader(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({ header: name, source: "caller", action: "dropped_sensitive_header" });
      continue;
    }
    if (!policy.passthroughAllowlist.includes(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      continue;
    }
    headers[name] = value;
    summary.passthroughHeaderNames.push(name);
  }

  for (const { name, value } of policy.staticHeaders) {
    if (isReservedProtocolHeader(name)) {
      summary.collisionRules.push({ header: name, source: "static", action: "dropped_reserved_header" });
      continue;
    }
    if (managedCredentialHeaders.has(name)) {
      summary.collisionRules.push({ header: name, source: "static", action: "kept_managed_credential" });
      continue;
    }
    if (headers[name] !== undefined) {
      summary.collisionRules.push({ header: name, source: "static", action: "overrode_passthrough" });
    }
    headers[name] = value;
    summary.staticHeaderNames.push(name);
  }

  for (const key of policy.metadataHeaders) {
    const rawValue = input.metadataValues?.[key];
    if (rawValue === undefined || rawValue === null || rawValue.length === 0) continue;
    const name = `x-paperclip-${key.replace(/_/g, "-")}`;
    const value = normalizedHeaderValue(rawValue);
    if (managedCredentialHeaders.has(name)) {
      summary.collisionRules.push({ header: name, source: "metadata", action: "kept_managed_credential" });
      continue;
    }
    if (headers[name] !== undefined) {
      summary.collisionRules.push({ header: name, source: "metadata", action: "overrode_previous_header" });
    }
    headers[name] = value;
    summary.metadataHeaderNames.push(name);
  }

  for (const [name, value] of Object.entries(credentialHeaders)) {
    if (isReservedProtocolHeader(name)) {
      summary.collisionRules.push({ header: name, source: "credential", action: "dropped_reserved_header" });
      continue;
    }
    if (headers[name] !== undefined) {
      summary.collisionRules.push({ header: name, source: "credential", action: "overrode_previous_header" });
    }
    const outputName = input.preserveCredentialHeaderCase
      ? credentialOutputNames.get(name) ?? name
      : name;
    headers[outputName] = value;
  }

  summary.staticHeaderNames = uniqueSorted(summary.staticHeaderNames);
  summary.credentialHeaderNames = uniqueSorted(summary.credentialHeaderNames);
  summary.passthroughHeaderNames = uniqueSorted(summary.passthroughHeaderNames);
  summary.droppedPassthroughHeaderNames = uniqueSorted(summary.droppedPassthroughHeaderNames);
  summary.metadataHeaderNames = uniqueSorted(summary.metadataHeaderNames);
  return { headers, summary };
}
