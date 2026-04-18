import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getAllCommitsUpTo,
  getBaseRef,
  getCommitsBetween,
  getCurrentBranch,
  getDiffBetween,
  getDiffFromEmpty,
  getDiffStat,
  getHeadSha,
  getLastTag,
  getRemoteUrl,
  getRepoRoot,
  getRootCommit,
  isClean,
  isGitRepo,
  isPathDirty,
  listTags,
} from '../src/core/git.ts';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.ts';

let fx: GitFixture;

beforeEach(async () => {
  fx = await createGitFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('isGitRepo', () => {
  it('returns true inside an initialized repo', async () => {
    expect(await isGitRepo({ cwd: fx.dir })).toBe(true);
  });

  it('returns false outside any repo', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'releasewise-not-git-'));
    try {
      expect(await isGitRepo({ cwd: bareDir })).toBe(false);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe('getRepoRoot', () => {
  it('returns the absolute path to the repo root', async () => {
    fx.writeFile('a.txt', 'hello');
    await fx.commit('chore: init');
    const root = await getRepoRoot({ cwd: fx.dir });
    // macOS tmp is a symlink (/tmp → /private/tmp), so assert the suffix
    // rather than strict equality.
    expect(root.endsWith(fx.dir) || fx.dir.endsWith(root)).toBe(true);
  });

  it('works from a nested subdirectory', async () => {
    fx.writeFile('packages/sub/file.txt', 'x');
    await fx.commit('chore: init');
    const root = await getRepoRoot({
      cwd: join(fx.dir, 'packages/sub'),
    });
    expect(root.endsWith(fx.dir) || fx.dir.endsWith(root)).toBe(true);
  });
});

describe('getCurrentBranch', () => {
  it('returns main on a fresh init', async () => {
    fx.writeFile('a.txt', 'x');
    await fx.commit('chore: init');
    expect(await getCurrentBranch({ cwd: fx.dir })).toBe('main');
  });
});

describe('getHeadSha', () => {
  it('matches the SHA returned by commit()', async () => {
    fx.writeFile('a.txt', 'x');
    const sha = await fx.commit('chore: init');
    expect(await getHeadSha({ cwd: fx.dir })).toBe(sha);
  });
});

describe('listTags + getLastTag', () => {
  it('listTags is empty before any tag is created', async () => {
    fx.writeFile('a.txt', 'x');
    await fx.commit('chore: init');
    expect(await listTags({ cwd: fx.dir })).toEqual([]);
  });

  it('getLastTag is null before any tag is created', async () => {
    fx.writeFile('a.txt', 'x');
    await fx.commit('chore: init');
    expect(await getLastTag({ cwd: fx.dir })).toBeNull();
  });

  it('getLastTag returns the most recent tag reachable from HEAD', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: v1');
    await fx.tag('v1.0.0');

    fx.writeFile('a.txt', '2');
    await fx.commit('feat: v2');
    await fx.tag('v1.1.0');

    expect(await getLastTag({ cwd: fx.dir })).toBe('v1.1.0');
  });
});

describe('getRootCommit', () => {
  it('returns the first commit SHA', async () => {
    fx.writeFile('a.txt', '1');
    const first = await fx.commit('chore: first');
    fx.writeFile('a.txt', '2');
    await fx.commit('chore: second');
    expect(await getRootCommit({ cwd: fx.dir })).toBe(first);
  });
});

describe('getBaseRef', () => {
  it('returns the explicit value when provided (even if a tag exists)', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.tag('v1.0.0');
    expect(await getBaseRef('HEAD~0', { cwd: fx.dir })).toBe('HEAD~0');
  });

  it('falls back to the last tag when no explicit', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.tag('v1.0.0');
    fx.writeFile('a.txt', '2');
    await fx.commit('feat: more');
    expect(await getBaseRef(undefined, { cwd: fx.dir })).toBe('v1.0.0');
  });

  it('falls back to the root commit when no tag exists', async () => {
    fx.writeFile('a.txt', '1');
    const first = await fx.commit('chore: init');
    fx.writeFile('a.txt', '2');
    await fx.commit('feat: more');
    expect(await getBaseRef(undefined, { cwd: fx.dir })).toBe(first);
  });
});

describe('getCommitsBetween', () => {
  it('returns empty when the range has no commits', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    const commits = await getCommitsBetween('HEAD', 'HEAD', { cwd: fx.dir });
    expect(commits).toEqual([]);
  });

  it('returns commits newest-first with parsed fields', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.tag('v1.0.0');

    fx.writeFile('a.txt', '2');
    await fx.commit('feat: add a');
    fx.writeFile('b.txt', '1');
    await fx.commit('fix: handle b');

    const commits = await getCommitsBetween('v1.0.0', 'HEAD', {
      cwd: fx.dir,
    });
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe('fix: handle b');
    expect(commits[1]?.subject).toBe('feat: add a');
    expect(commits[0]?.author).toBe('Releasewise Test');
    expect(commits[0]?.authorEmail).toBe('test@releasewise.dev');
    expect(commits[0]?.sha.length).toBe(40);
    expect(commits[0]?.shortSha.length).toBeGreaterThan(0);
    expect(commits[0]?.shortSha.length).toBeLessThan(commits[0]!.sha.length);
  });

  it('parses commit subjects containing tricky punctuation', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.tag('v0');

    fx.writeFile('a.txt', '2');
    // Subject contains tabs, pipes, and newlines in the body.
    await fx.commit(
      'feat(api)!: drop v1 | breaking | special\ttab',
      'BREAKING CHANGE: body\nhas\nnewlines',
    );

    const commits = await getCommitsBetween('v0', 'HEAD', { cwd: fx.dir });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe(
      'feat(api)!: drop v1 | breaking | special\ttab',
    );
    expect(commits[0]?.body).toContain('BREAKING CHANGE');
    expect(commits[0]?.body).toContain('newlines');
  });
});

describe('getAllCommitsUpTo', () => {
  it('returns the single commit for a fresh repo with no tags', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('feat: initial');

    const commits = await getAllCommitsUpTo('HEAD', { cwd: fx.dir });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('feat: initial');
  });

  it('returns every commit newest-first including the root', async () => {
    fx.writeFile('a.txt', '1');
    const root = await fx.commit('feat: initial');
    fx.writeFile('a.txt', '2');
    await fx.commit('feat: second');
    fx.writeFile('b.txt', '1');
    await fx.commit('fix: third');

    const commits = await getAllCommitsUpTo('HEAD', { cwd: fx.dir });
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe('fix: third');
    expect(commits[1]?.subject).toBe('feat: second');
    expect(commits[2]?.subject).toBe('feat: initial');
    expect(commits[2]?.sha).toBe(root);
  });
});

describe('getDiffFromEmpty', () => {
  it('includes the root commit file contents on a single-commit repo', async () => {
    fx.writeFile('a.txt', 'hello\n');
    await fx.commit('feat: initial');

    const diff = await getDiffFromEmpty('HEAD', { cwd: fx.dir });
    expect(diff).toContain('a.txt');
    expect(diff).toContain('+hello');
  });

  it('includes the root commit file contents on a multi-commit repo', async () => {
    fx.writeFile('root.txt', 'root-content\n');
    await fx.commit('feat: initial');
    fx.writeFile('later.txt', 'later-content\n');
    await fx.commit('feat: later');

    const diff = await getDiffFromEmpty('HEAD', { cwd: fx.dir });
    expect(diff).toContain('root.txt');
    expect(diff).toContain('+root-content');
    expect(diff).toContain('later.txt');
    expect(diff).toContain('+later-content');
  });
});

describe('getDiffBetween + getDiffStat', () => {
  it('returns a unified diff and stat summary between refs', async () => {
    fx.writeFile('a.txt', 'first\n');
    await fx.commit('chore: init');
    await fx.tag('v1');

    fx.writeFile('a.txt', 'first\nsecond\n');
    fx.writeFile('b.txt', 'new file\n');
    await fx.commit('feat: more');

    const diff = await getDiffBetween('v1', 'HEAD', { cwd: fx.dir });
    expect(diff).toContain('+second');
    expect(diff).toContain('b.txt');

    const stat = await getDiffStat('v1', 'HEAD', { cwd: fx.dir });
    expect(stat).toContain('a.txt');
    expect(stat).toContain('b.txt');
  });
});

describe('getRemoteUrl', () => {
  it('returns null when no origin is configured', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    expect(await getRemoteUrl('origin', { cwd: fx.dir })).toBeNull();
  });

  it('returns the configured origin URL', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.addRemote('git@github.com:foo/bar.git');
    expect(await getRemoteUrl('origin', { cwd: fx.dir })).toBe(
      'git@github.com:foo/bar.git',
    );
  });

  it('returns null for a non-existent remote name', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    expect(await getRemoteUrl('upstream', { cwd: fx.dir })).toBeNull();
  });
});

describe('isClean', () => {
  it('is true right after a commit', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    expect(await isClean({ cwd: fx.dir })).toBe(true);
  });

  it('is false after an unstaged edit', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    fx.writeFile('a.txt', 'dirty');
    expect(await isClean({ cwd: fx.dir })).toBe(false);
  });

  it('is false when an untracked file exists', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    fx.writeFile('new.txt', 'brand new');
    expect(await isClean({ cwd: fx.dir })).toBe(false);
  });
});

describe('isPathDirty', () => {
  it('is false when the named file is clean', async () => {
    fx.writeFile('package.json', '{"version":"1.0.0"}');
    await fx.commit('chore: init');
    expect(await isPathDirty('package.json', { cwd: fx.dir })).toBe(false);
  });

  it('is true when the named file has unstaged changes', async () => {
    fx.writeFile('package.json', '{"version":"1.0.0"}');
    await fx.commit('chore: init');
    fx.writeFile('package.json', '{"version":"1.0.1"}');
    expect(await isPathDirty('package.json', { cwd: fx.dir })).toBe(true);
  });

  it('ignores dirtiness in other paths', async () => {
    fx.writeFile('package.json', '{"version":"1.0.0"}');
    fx.writeFile('CHANGELOG.md', '# Changelog');
    await fx.commit('chore: init');
    fx.writeFile('CHANGELOG.md', '# Changelog\n\nEdit');
    expect(await isPathDirty('package.json', { cwd: fx.dir })).toBe(false);
    expect(await isPathDirty('CHANGELOG.md', { cwd: fx.dir })).toBe(true);
  });

  it('returns false for an untracked path (file we are about to create)', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    // CHANGELOG.md does not yet exist in the repo at all.
    expect(await isPathDirty('CHANGELOG.md', { cwd: fx.dir })).toBe(false);
  });
});
