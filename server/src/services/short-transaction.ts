/**
 * Run `work` inside `transaction`, then run failure handling only after that
 * transaction has settled. Drizzle releases the pooled connection when the
 * transaction callback rejects. Recording the failure on the root pool from
 * inside the callback checks out a second connection while the first is still
 * reserved, and a full pool then fails the checkout with CONNECT_TIMEOUT.
 */
export async function withReleasedTransaction<C, T>(
  transaction: (work: (ctx: C) => Promise<T>) => Promise<T>,
  work: (ctx: C) => Promise<T>,
  onFailureAfterRelease?: (error: unknown) => Promise<void>,
): Promise<T> {
  let failure: unknown;
  let failed = false;
  try {
    return await transaction(async (ctx) => {
      try {
        return await work(ctx);
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
    });
  } catch (error) {
    if (failed && onFailureAfterRelease) {
      try {
        await onFailureAfterRelease(failure);
      } catch {
        // The migration error is the one callers match. A failed ledger write
        // must not hide it, and it must not keep the original connection.
      }
    }
    throw error;
  }
}
