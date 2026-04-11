/**
 * Exponential-backoff retry wrapper for flaky operations (AI calls,
 * network I/O). Keeps call sites clean:
 *
 *     const result = await withRetry(() => client.messages.create(...));
 *
 * Defaults: 3 attempts total (initial + 2 retries), 500ms base delay,
 * 2x growth factor. A `shouldRetry` predicate can short-circuit on
 * non-retryable errors (e.g. HTTP 400 — retrying won't help).
 *
 * Sleeping is injected so tests stay deterministic and fast.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 3). Must be ≥ 1. */
  attempts?: number;
  /** Base delay before the first retry, in ms (default 500). */
  baseDelayMs?: number;
  /** Multiplier applied to the delay on each retry (default 2). */
  factor?: number;
  /**
   * Called on each failure *before* the next retry. Return `false` to
   * stop retrying immediately and re-throw the current error. Default:
   * always retry.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Override the delay implementation — used by tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `withRetry: attempts must be an integer ≥ 1, got ${attempts}`,
    );
  }
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const factor = opts.factor ?? 2;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      if (!shouldRetry(err, attempt)) break;
      const delay = baseDelayMs * Math.pow(factor, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastError;
}
