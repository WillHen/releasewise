/**
 * Transaction log for `releasewise undo`.
 *
 * After every successful `executeRelease`, a log is written to
 * `.releasewise/last-release.json`. The `undo` command reads this log
 * and reverses the release (delete tag, reset commit) — but only if
 * the release was not pushed.
 *
 * Because `undo` performs DESTRUCTIVE git operations (`git tag -d`,
 * `git reset --hard`) driven entirely by this file, the contents are
 * validated with Zod on read — exactly like `.releasewise.json` config
 * (see config-loader.ts). A corrupt, hand-edited, partially-written, or
 * incompatible log raises a clear `TransactionLogValidationError` rather
 * than silently feeding bad data into a reset.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { ErrorCodes } from '../errors.ts';
import type { TransactionLog } from '../types.ts';

/** Default location of the transaction log, relative to the repo root. */
const LOG_DIR = '.releasewise';
const LOG_FILE = 'last-release.json';

const transactionLogSchema = z.object({
  timestamp: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  bumpCommitSha: z.string().nullable(),
  tagName: z.string().nullable(),
  pushed: z.boolean(),
  githubReleaseId: z.string().nullable(),
  filesModified: z.array(z.string()),
});

// Compile-time guard: fails `tsc` if the schema and the `TransactionLog`
// interface in types.ts drift apart in either direction.
type _AssertSchemaMatches =
  z.infer<typeof transactionLogSchema> extends TransactionLog
    ? TransactionLog extends z.infer<typeof transactionLogSchema>
      ? true
      : never
    : never;
const _schemaMatchesInterface: _AssertSchemaMatches = true;
void _schemaMatchesInterface;

/**
 * Raised when the transaction log exists but cannot be trusted: invalid
 * JSON or a shape that fails the schema. Duck-typed by `formatError` via
 * the `code`/`hint` fields (see errors.ts).
 */
export class TransactionLogValidationError extends Error {
  readonly code = ErrorCodes.TRANSACTION_LOG_INVALID;
  readonly hint =
    'The log is corrupt and undo cannot run safely. ' +
    'Reverse the release manually (git tag -d <tag>; git reset --hard <parent>), ' +
    'then delete .releasewise/last-release.json.';
  constructor(filePath: string, detail: string, cause?: unknown) {
    super(
      `Invalid transaction log at ${filePath}:\n${detail}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'TransactionLogValidationError';
  }
}

export function transactionLogPath(cwd: string): string {
  return join(cwd, LOG_DIR, LOG_FILE);
}

export async function writeTransactionLog(
  cwd: string,
  log: TransactionLog,
): Promise<void> {
  const path = transactionLogPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

export async function readTransactionLog(
  cwd: string,
): Promise<TransactionLog | null> {
  const path = transactionLogPath(cwd);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Genuinely absent or unreadable — the caller reports "nothing to undo".
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TransactionLogValidationError(
      path,
      `  • file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const result = transactionLogSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new TransactionLogValidationError(path, detail, result.error);
  }

  return result.data;
}
