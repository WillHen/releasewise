/**
 * Transaction log for `releasewise undo`.
 *
 * After every successful `executeRelease`, a log is written to
 * `.releasewise/last-release.json`. The `undo` command reads this log
 * and reverses the release (delete tag, reset commit) — but only if
 * the release was not pushed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TransactionLog } from '../types.ts';

/** Default location of the transaction log, relative to the repo root. */
const LOG_DIR = '.releasewise';
const LOG_FILE = 'last-release.json';

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
  try {
    const raw = await readFile(transactionLogPath(cwd), 'utf8');
    return JSON.parse(raw) as TransactionLog;
  } catch {
    return null;
  }
}
