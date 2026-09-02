import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import {
  requestPathForHttpLog,
  shouldOmitHttpRequestBody,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function buildFailedResponseContext(req: any, res: any): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const ctx = res.__errorContext;
  const requestUrl = req.originalUrl ?? req.url;
  if (ctx?.error) props.errorContext = redactSensitive(ctx.error);

  const body = ctx?.reqBody ?? req.body;
  if (!shouldOmitHttpRequestBody(requestUrl) && isNonEmptyRecord(body)) {
    props.reqBody = redactSensitive(body);
  }

  const params = ctx?.reqParams ?? req.params;
  if (isNonEmptyRecord(params)) props.reqParams = redactSensitive(params);
  if (req.route?.path) props.routePath = req.route.path;
  return props;
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
        };
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
    customSuccessMessage(req, res) {
      return `${req.method} ${requestPathForHttpLog(req.url)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      const ctx = (res as any).__errorContext;
      const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
      return `${req.method} ${requestPathForHttpLog(req.url)} ${res.statusCode} — ${errMsg}`;
    },
    customSuccessObject(req, res, value) {
      if (res.statusCode < 400) return value;
      return { ...value, ...buildFailedResponseContext(req, res) };
    },
    customErrorObject(req, res, _error, value) {
      return { ...value, ...buildFailedResponseContext(req, res) };
    },
  });
}
