import { HttpError } from "../errors.js";

export const NATIVE_BOARD_FAILURE_SCHEMA = "native-github-board-scheduled-failure.v1";
/** Static host prose only: no digits, ids, URLs, quotes or colons, so no provider or board data can pass. */
const STATIC_HOST_MESSAGE = /^[A-Za-z][A-Za-z ,;.'()-]{5,159}$/;

export interface NativeBoardFailureSummary {
  schema: typeof NATIVE_BOARD_FAILURE_SCHEMA;
  status: "refused";
  /** HTTP-style class of the host check that refused, or 0 when the error was not a host-owned refusal. */
  httpStatus: number;
  /** The host's own static refusal sentence, or a fixed label when the error is not one. */
  reason: string;
}

/**
 * Names why a scheduled native board run was refused without copying provider errors or board data.
 * A host-owned HttpError whose message is static prose is kept; anything else becomes a fixed label plus
 * only its constructor name (a database or network error can carry values, so its text is never read).
 */
export function summarizeNativeBoardFailure(error: unknown): NativeBoardFailureSummary {
  if (error instanceof HttpError && [403, 409, 422].includes(error.status) && STATIC_HOST_MESSAGE.test(error.message)) {
    return { schema: NATIVE_BOARD_FAILURE_SCHEMA, status: "refused", httpStatus: error.status, reason: error.message };
  }
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.constructor.name)
    ? error.constructor.name : "NonError";
  return { schema: NATIVE_BOARD_FAILURE_SCHEMA, status: "refused", httpStatus: 0, reason: `unclassified ${name}` };
}
