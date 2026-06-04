import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  readTransactionLog,
  TransactionLogValidationError,
  transactionLogPath,
  writeTransactionLog,
} from '../src/core/rollback.ts';
import type { TransactionLog } from '../src/types.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'releasewise-rollback-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sampleLog(overrides?: Partial<TransactionLog>): TransactionLog {
  return {
    timestamp: '2026-04-12T00:00:00.000Z',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    bumpCommitSha: 'abc1234567890abcdef1234567890abcdef123456',
    tagName: 'v1.1.0',
    pushed: false,
    githubReleaseId: null,
    filesModified: ['package.json', 'CHANGELOG.md'],
    ...overrides,
  };
}

describe('transactionLogPath', () => {
  it('returns .releasewise/last-release.json under cwd', () => {
    const path = transactionLogPath('/some/repo');
    expect(path).toBe('/some/repo/.releasewise/last-release.json');
  });
});

describe('writeTransactionLog', () => {
  it('creates the .releasewise directory and writes the log', async () => {
    const log = sampleLog();
    await writeTransactionLog(tmpDir, log);

    const path = transactionLogPath(tmpDir);
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.fromVersion).toBe('1.0.0');
    expect(parsed.toVersion).toBe('1.1.0');
    expect(parsed.pushed).toBe(false);
  });

  it('overwrites a previous log', async () => {
    await writeTransactionLog(tmpDir, sampleLog({ toVersion: '1.1.0' }));
    await writeTransactionLog(tmpDir, sampleLog({ toVersion: '2.0.0' }));

    const path = transactionLogPath(tmpDir);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.toVersion).toBe('2.0.0');
  });

  it('writes pretty-printed JSON with trailing newline', async () => {
    await writeTransactionLog(tmpDir, sampleLog());

    const raw = readFileSync(transactionLogPath(tmpDir), 'utf8');
    expect(raw).toEndWith('\n');
    expect(raw).toContain('\n  '); // indented
  });
});

describe('readTransactionLog', () => {
  it('returns the log when it exists', async () => {
    await writeTransactionLog(tmpDir, sampleLog());
    const log = await readTransactionLog(tmpDir);

    expect(log).not.toBeNull();
    expect(log!.fromVersion).toBe('1.0.0');
    expect(log!.tagName).toBe('v1.1.0');
  });

  it('returns null when no log exists', async () => {
    const log = await readTransactionLog(tmpDir);
    expect(log).toBeNull();
  });

  it('round-trips all fields', async () => {
    const original = sampleLog({
      pushed: true,
      githubReleaseId: 'gh-12345',
    });
    await writeTransactionLog(tmpDir, original);
    const loaded = await readTransactionLog(tmpDir);

    expect(loaded).toEqual(original);
  });

  /** Write raw bytes to the log path, bypassing the schema-checked writer. */
  function writeRawLog(contents: string): void {
    const path = transactionLogPath(tmpDir);
    mkdirSync(join(tmpDir, '.releasewise'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }

  it('throws on invalid JSON instead of returning null', async () => {
    writeRawLog('{ not valid json');

    await expect(readTransactionLog(tmpDir)).rejects.toBeInstanceOf(
      TransactionLogValidationError,
    );
  });

  it('throws when a field has the wrong type', async () => {
    writeRawLog(JSON.stringify({ ...sampleLog(), pushed: 'yes' }));

    const err = await readTransactionLog(tmpDir).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionLogValidationError);
    expect(String(err.message)).toContain('pushed');
  });

  it('throws when a required field is missing', async () => {
    const { bumpCommitSha: _omit, ...incomplete } = sampleLog();
    writeRawLog(JSON.stringify(incomplete));

    const err = await readTransactionLog(tmpDir).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionLogValidationError);
    expect(String(err.message)).toContain('bumpCommitSha');
  });

  it('throws when filesModified is not a string array', async () => {
    writeRawLog(JSON.stringify({ ...sampleLog(), filesModified: 'nope' }));

    await expect(readTransactionLog(tmpDir)).rejects.toBeInstanceOf(
      TransactionLogValidationError,
    );
  });
});
