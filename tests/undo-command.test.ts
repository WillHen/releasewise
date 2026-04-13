import { describe, expect, it } from 'bun:test';

import { runUndo, type RunUndoDeps } from '../src/commands/undo.ts';
import type { TransactionLog } from '../src/types.ts';

// --------- Helpers ---------

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

interface Captured {
  stdout: string;
  stderr: string;
  deletedTags: string[];
  resetRefs: string[];
}

function makeDeps(
  log: TransactionLog | null,
  overrides?: Partial<RunUndoDeps>,
): { deps: RunUndoDeps; captured: Captured } {
  const captured: Captured = {
    stdout: '',
    stderr: '',
    deletedTags: [],
    resetRefs: [],
  };

  const deps: RunUndoDeps = {
    cwd: '/fake/repo',
    stdout: (t: string) => {
      captured.stdout += t;
    },
    stderr: (t: string) => {
      captured.stderr += t;
    },
    readTransactionLog: async () => log,
    isClean: async () => true,
    deleteTag: async (name: string) => {
      captured.deletedTags.push(name);
    },
    resetHard: async (ref: string) => {
      captured.resetRefs.push(ref);
    },
    // By default: parent exists; return a stable fake parent SHA.
    resolveRef: async (_ref: string) =>
      'parent0000000000000000000000000000000000',
    ...overrides,
  };

  return { deps, captured };
}

// --------- Tests ---------

describe('runUndo', () => {
  it('returns exitCode 1 when no transaction log exists', async () => {
    const { deps, captured } = makeDeps(null);
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('no transaction log found');
  });

  it('returns exitCode 1 when release was already pushed', async () => {
    const { deps, captured } = makeDeps(sampleLog({ pushed: true }));
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('already pushed');
    expect(captured.stderr).toContain('git tag -d v1.1.0');
    expect(captured.stderr).toContain('git revert');
  });

  it('returns exitCode 1 when working tree is dirty', async () => {
    const { deps, captured } = makeDeps(sampleLog(), {
      isClean: async () => false,
    });
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('uncommitted changes');
  });

  it('deletes the tag and resets to the resolved parent on success', async () => {
    const log = sampleLog();
    const queriedRefs: string[] = [];
    const parentSha = 'parent0000000000000000000000000000000000';
    const { deps, captured } = makeDeps(log, {
      resolveRef: async (ref: string) => {
        queriedRefs.push(ref);
        return parentSha;
      },
    });
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(0);
    expect(captured.deletedTags).toEqual(['v1.1.0']);
    expect(queriedRefs).toEqual([`${log.bumpCommitSha}^`]);
    expect(captured.resetRefs).toEqual([parentSha]);
    expect(captured.stdout).toContain('Undone: v1.1.0');
    expect(captured.stdout).toContain('Tag deleted:    v1.1.0');
    expect(captured.stdout).toContain('Version restored: 1.0.0');
  });

  it('skips tag deletion when tagName is null', async () => {
    const { deps, captured } = makeDeps(sampleLog({ tagName: null }));
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(0);
    expect(captured.deletedTags).toEqual([]);
    expect(captured.stdout).toContain('Tag deleted:    (none)');
  });

  it('errors when bumpCommitSha is null (malformed transaction log)', async () => {
    const { deps, captured } = makeDeps(sampleLog({ bumpCommitSha: null }));
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('missing `bumpCommitSha`');
    // Nothing was touched.
    expect(captured.deletedTags).toEqual([]);
    expect(captured.resetRefs).toEqual([]);
  });

  it('errors cleanly when the release commit has no parent (root commit)', async () => {
    const { deps, captured } = makeDeps(sampleLog(), {
      resolveRef: async () => null, // parent doesn't resolve
    });
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('root commit');
    expect(captured.stderr).toContain('git update-ref -d HEAD');
    // Refuses to touch anything in the dangerous path.
    expect(captured.deletedTags).toEqual([]);
    expect(captured.resetRefs).toEqual([]);
  });

  it('catches and reports errors from git operations', async () => {
    const { deps, captured } = makeDeps(sampleLog(), {
      deleteTag: async () => {
        throw new Error('tag not found');
      },
    });
    const result = await runUndo(deps);

    expect(result.exitCode).toBe(1);
    expect(captured.stderr).toContain('tag not found');
  });

  it('shows abbreviated SHA in success output', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const { deps, captured } = makeDeps(sampleLog({ bumpCommitSha: sha }));
    await runUndo(deps);

    expect(captured.stdout).toContain('Commit reverted: abcdef1');
  });
});
