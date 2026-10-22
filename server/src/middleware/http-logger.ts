import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import {
  requestPathForHttpLog,
  shouldOmitHttpRequestBody,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import { redactHttpHeaders } from "./http-log-redaction.js";
import { redactSensitive } from "./redact-sensitive.js";

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

const ALLOWED_ERROR_CONTEXT_KEYS = new Set([
  "code",
  "name",
  "statusCode",
  "status",
  "path",
  "reason",
]);

function buildSafeErrorContext(error: unknown): Record<string, unknown> | null {
  if (!isNonEmptyRecord(error)) return null;
  const safeRecord: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (ALLOWED_ERROR_CONTEXT_KEYS.has(key)) {
      safeRecord[key] = value;
    }
  }
  return isNonEmptyRecord(safeRecord) ? (redactSensitive(safeRecord) as Record<string, unknown>) : null;
}

// pino-http copies res.err (the raw exception the error handler attaches) into
// the log object as `err`. Its message and the first stack lines can carry
// credentials, connection strings, or user payloads, so replace it with the
// error type, allowlisted fields, and stack frames only (no message text).
function buildSafeErr(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error !== "object") return { type: typeof error };
  const record = error as Record<string, unknown>;
  const ctorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
  const safe: Record<string, unknown> = {
    type: typeof ctorName === "string" && ctorName.length > 0 ? ctorName : "Object",
  };
  const allowlisted = buildSafeErrorContext(
    Object.fromEntries(
      ["code", "name", "statusCode", "status"]
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, record[key]]),
    ),
  );
  if (allowlisted) Object.assign(safe, allowlisted);
  if (typeof record.stack === "string") {
    const frames = record.stack.split("\n").filter((line) => /^\s+at\s/.test(line));
    if (frames.length > 0) safe.stack = frames.join("\n");
  }
  return safe;
}

function withSafeErr(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(value, "err")) return value;
  const { err, ...rest } = value;
  const safeErr = buildSafeErr(err);
  return safeErr ? { ...rest, err: safeErr } : rest;
}

function buildFailedResponseContext(req: any, res: any): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const ctx = res.__errorContext;
  const requestUrl = req.originalUrl ?? req.url;
  if (ctx?.error) {
    const safeContext = buildSafeErrorContext(ctx.error);
    if (safeContext) props.errorContext = safeContext;
  }

  const body = ctx?.reqBody ?? req.body;
  if (!shouldOmitHttpRequestBody(requestUrl) && isNonEmptyRecord(body)) {
    props.reqBody = redactSensitive(body);
  }

  const params = ctx?.reqParams ?? req.params;
  if (isNonEmptyRecord(params)) props.reqParams = redactSensitive(params);
  if (req.route?.path) props.routePath = req.route.path;
  return props;
}

function logUrl(req: unknown): string | undefined {
  const record = req as { originalUrl?: string; url?: string };
  return record.originalUrl ?? record.url;
}

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      req(req) {
        const { query: _query, params: _params, ...safeReq } = req as Record<string, unknown>;
        return {
          ...safeReq,
          url: requestPathForHttpLog(req.url),
          ...(safeReq.headers ? { headers: redactHttpHeaders(safeReq.headers) } : {}),
        };
      },
      res(res) {
        const record = res as Record<string, unknown>;
        return record.headers ? { ...record, headers: redactHttpHeaders(record.headers) } : record;
      },
    },
    customLogLevel(_req, res, err) {
      if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
        return "silent";
      }
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    // Routers mounted at /api strip that prefix from req.url, so build the
    // message from originalUrl, or path-token redaction never matches.
    customSuccessMessage(req, res) {
      return `${req.method} ${requestPathForHttpLog(logUrl(req))} ${res.statusCode}`;
    },
    customErrorMessage(req, res) {
      return `${req.method} ${requestPathForHttpLog(logUrl(req))} ${res.statusCode} — request failed`;
    },
    customSuccessObject(req, res, value) {
      if (res.statusCode < 400) return withSafeErr(value);
      return { ...withSafeErr(value), ...buildFailedResponseContext(req, res) };
    },
    customErrorObject(req, res, _error, value) {
      return { ...withSafeErr(value), ...buildFailedResponseContext(req, res) };
    },
  });
}
