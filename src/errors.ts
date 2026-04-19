/**
 * Shared error type and formatter for releasewise.
 *
 * Design:
 *   - `ReleaseError` — carries a machine-readable `code`, a human `hint`,
 *     an optional `step` label, and the underlying `cause` (ES2022 field).
 *   - `ErrorCodes` — the stable code taxonomy; downstream tools grep on
 *     these.
 *   - `withStep(step, code, hint, fn)` — try/catch wrapper for orchestrator
 *     phases. Raw errors become a `ReleaseError`; existing `ReleaseError`s
 *     get annotated with the step (if missing) and rethrown unchanged.
 *   - `formatError(err, { verbose })` — the one thing command catches call.
 *     Normal mode: `Error [CODE] during step: msg` + `Hint: ...`. Verbose:
 *     also prints the cause chain with stacks.
 *
 * Existing custom error classes (`ConfigNotFoundError`, `MissingApiKeyError`,
 * `ClassifierError`, …) are not reparented onto `ReleaseError` — they just
 * gain `code`/`hint` instance fields, and the formatter duck-types them via
 * `CodedError`.
 */

export const ErrorCodes = {
  CONFIG_MISSING: 'ERR_CONFIG_MISSING',
  CONFIG_UNREADABLE: 'ERR_CONFIG_UNREADABLE',
  CONFIG_INVALID_JSON: 'ERR_CONFIG_INVALID_JSON',
  CONFIG_INVALID: 'ERR_CONFIG_INVALID',
  API_KEY_MISSING: 'ERR_API_KEY_MISSING',
  CLASSIFIER_FAILED: 'ERR_CLASSIFIER_FAILED',
  CLASSIFIER_PARSE: 'ERR_CLASSIFIER_PARSE',
  RELEASE_NO_COMMITS: 'ERR_RELEASE_NO_COMMITS',
  RELEASE_DIRTY: 'ERR_RELEASE_DIRTY',
  GIT_COMMIT_FAILED: 'ERR_GIT_COMMIT_FAILED',
  GIT_TAG_FAILED: 'ERR_GIT_TAG_FAILED',
  GIT_PUSH_FAILED: 'ERR_GIT_PUSH_FAILED',
  GITHUB_RELEASE_FAILED: 'ERR_GITHUB_RELEASE_FAILED',
  UNKNOWN: 'ERR_UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ReleaseErrorOptions {
  code: string;
  message: string;
  hint?: string;
  step?: string;
  cause?: unknown;
  details?: Record<string, string | number | boolean>;
}

export class ReleaseError extends Error {
  readonly code: string;
  readonly hint?: string;
  step?: string;
  readonly details?: Record<string, string | number | boolean>;

  constructor(opts: ReleaseErrorOptions) {
    super(
      opts.message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'ReleaseError';
    this.code = opts.code;
    this.hint = opts.hint;
    this.step = opts.step;
    this.details = opts.details;
  }
}

/**
 * Structural view of any error shape the formatter can handle. Lets us
 * read `code`/`hint`/`step` off a `ReleaseError`, off an existing class
 * like `ConfigValidationError` that gained a `code` field, or off a plain
 * `Error` (where the fields are simply undefined).
 */
export interface CodedError {
  name?: string;
  message?: string;
  code?: string;
  hint?: string;
  step?: string;
  cause?: unknown;
  stack?: string;
}

const MAX_CAUSE_DEPTH = 10;

/**
 * Walk the `cause` chain looking for the first `ReleaseError`. Used by
 * command catches so a `ReleaseError` wrapped higher up by a plain
 * `Error` is still detected.
 */
export function findReleaseError(err: unknown): ReleaseError | null {
  let cur: unknown = err;
  for (let i = 0; i < MAX_CAUSE_DEPTH && cur; i++) {
    if (cur instanceof ReleaseError) return cur;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return null;
}

/**
 * Run `fn` and, on throw, either annotate a `ReleaseError` with `step`
 * (when missing) or wrap a raw error in a new `ReleaseError` with the
 * original as `cause`. Never double-wraps.
 */
export async function withStep<T>(
  step: string,
  code: string,
  hint: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ReleaseError) {
      if (!err.step) err.step = step;
      throw err;
    }
    const inner = err instanceof Error ? err.message : String(err);
    throw new ReleaseError({
      code,
      step,
      message: `${step} failed: ${inner}`,
      hint,
      cause: err,
    });
  }
}

/**
 * Format any error for display to the user. Pure function — returns the
 * full stderr string including the trailing newline.
 */
export function formatError(err: unknown, opts: { verbose: boolean }): string {
  const primary =
    findReleaseError(err) ??
    (isCodedError(err) ? (err as CodedError) : undefined);
  const code = primary?.code ?? ErrorCodes.UNKNOWN;
  const message =
    primary?.message ?? (err instanceof Error ? err.message : String(err));
  const hint = primary?.hint;
  const step = primary?.step;

  const lines: string[] = [];
  lines.push(step ? `Error [${code}] during ${step}:` : `Error [${code}]:`);
  for (const l of String(message).split('\n')) {
    lines.push(`  ${l}`);
  }
  if (hint) {
    lines.push('');
    lines.push(`Hint: ${hint}`);
  }

  if (opts.verbose) {
    lines.push('');
    lines.push('Cause chain:');
    let cur: unknown = err;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur; depth++) {
      const e = cur as CodedError;
      const eName = e?.name ?? (cur instanceof Error ? cur.name : 'Error');
      const eCode = e?.code ? ` (${e.code})` : '';
      const eMsg = e?.message ?? String(cur);
      lines.push(`  [${depth}] ${eName}${eCode}: ${eMsg}`);
      if (e?.stack) {
        const stackLines = String(e.stack).split('\n').slice(1);
        for (const sl of stackLines) {
          const trimmed = sl.trim();
          if (trimmed.length > 0) lines.push(`      ${trimmed}`);
        }
      }
      cur = (cur as { cause?: unknown } | null)?.cause;
    }
  }

  return lines.join('\n') + '\n';
}

function isCodedError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    ('message' in (err as object) || 'code' in (err as object))
  );
}
