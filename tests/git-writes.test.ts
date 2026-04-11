import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commit,
  createTag,
  deleteTag,
  getHeadSha,
  getLastTag,
  isClean,
  isPathDirty,
  listTags,
  push,
  resetHard,
} from '../src/core/git.ts';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.ts';

let fx: GitFixture;

beforeEach(async () => {
  fx = await createGitFixture();
});

afterEach(() => {
  fx.cleanup();
});

// ---------- commit ----------

describe('commit', () => {
  it('commits only the named paths and returns the new HEAD SHA', async () => {
    fx.writeFile('a.txt', '1');
    fx.writeFile('b.txt', '1');
    await fx.commit('chore: init');

    fx.writeFile('a.txt', '2');
    fx.writeFile('b.txt', '2');

    const sha = await commit('feat: update a', ['a.txt'], { cwd: fx.dir });
    expect(sha).toBe(await getHeadSha({ cwd: fx.dir }));

    // a.txt is committed → clean. b.txt still dirty.
    expect(await isPathDirty('a.txt', { cwd: fx.dir })).toBe(false);
    expect(await isPathDirty('b.txt', { cwd: fx.dir })).toBe(true);
  });

  it('preserves unrelated staged changes (commit <path> is path-scoped)', async () => {
    fx.writeFile('a.txt', '1');
    fx.writeFile('b.txt', '1');
    await fx.commit('chore: init');

    // Dirty a.txt (unrelated) and b.txt (the one we'll commit).
    fx.writeFile('a.txt', 'unrelated-wip');
    fx.writeFile('b.txt', 'release-file');

    await commit('chore(release): bump b', ['b.txt'], { cwd: fx.dir });

    // a.txt's dirty edit is untouched after the path-scoped commit.
    expect(await isPathDirty('a.txt', { cwd: fx.dir })).toBe(true);
    expect(await isPathDirty('b.txt', { cwd: fx.dir })).toBe(false);
  });

  it('throws when given an empty paths array', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await expect(commit('noop', [], { cwd: fx.dir })).rejects.toThrow(
      /at least one path/,
    );
  });

  it('stores the message on the new commit', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    fx.writeFile('a.txt', '2');
    const sha = await commit('feat: custom subject', ['a.txt'], {
      cwd: fx.dir,
    });
    const out = await $`git show -s --format=%s ${sha}`.cwd(fx.dir).text();
    expect(out.trim()).toBe('feat: custom subject');
  });
});

// ---------- createTag ----------

describe('createTag', () => {
  it('creates a lightweight tag pointing at HEAD', async () => {
    fx.writeFile('a.txt', '1');
    const sha = await fx.commit('chore: init');
    await createTag('v0.1.0', undefined, { cwd: fx.dir });

    const tags = await listTags({ cwd: fx.dir });
    expect(tags).toContain('v0.1.0');

    // Tag resolves to the same SHA as HEAD.
    const resolved = (
      await $`git rev-list -n 1 v0.1.0`.cwd(fx.dir).text()
    ).trim();
    expect(resolved).toBe(sha);
  });

  it('creates an annotated tag when a message is given', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await createTag('v0.2.0', 'Release 0.2.0', { cwd: fx.dir });

    const type = (await $`git cat-file -t v0.2.0`.cwd(fx.dir).text()).trim();
    expect(type).toBe('tag'); // annotated tags are type=tag, lightweight=commit
  });

  it('throws when the tag already exists', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await createTag('v0.1.0', undefined, { cwd: fx.dir });
    await expect(
      createTag('v0.1.0', undefined, { cwd: fx.dir }),
    ).rejects.toThrow();
  });
});

// ---------- deleteTag ----------

describe('deleteTag', () => {
  it('deletes an existing tag', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await createTag('v0.1.0', undefined, { cwd: fx.dir });
    await deleteTag('v0.1.0', { cwd: fx.dir });
    expect(await listTags({ cwd: fx.dir })).not.toContain('v0.1.0');
    expect(await getLastTag({ cwd: fx.dir })).toBeNull();
  });

  it('silently no-ops when the tag does not exist', async () => {
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    // Should not throw.
    await deleteTag('v-nope', { cwd: fx.dir });
  });
});

// ---------- push ----------

describe('push', () => {
  let bareDir: string;

  beforeEach(async () => {
    // Spin up a bare repo to serve as the "remote".
    bareDir = mkdtempSync(join(tmpdir(), 'releasewise-remote-'));
    await $`git init --bare -b main`.cwd(bareDir).quiet();
    fx.writeFile('a.txt', '1');
    await fx.commit('chore: init');
    await fx.addRemote(bareDir);
  });

  afterEach(() => {
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('pushes the current branch to the remote', async () => {
    const localSha = await getHeadSha({ cwd: fx.dir });
    await push({ cwd: fx.dir, ref: 'main', followTags: false });
    const remoteSha = (await $`git rev-parse main`.cwd(bareDir).text()).trim();
    expect(remoteSha).toBe(localSha);
  });

  it('pushes reachable annotated tags with --follow-tags (default)', async () => {
    await createTag('v0.1.0', 'first release', { cwd: fx.dir });
    await push({ cwd: fx.dir, ref: 'main' });

    // The remote now knows about v0.1.0.
    const remoteTag = (
      await $`git tag --list v0.1.0`.cwd(bareDir).text()
    ).trim();
    expect(remoteTag).toBe('v0.1.0');
  });

  it('does NOT push tags when followTags is false', async () => {
    await createTag('v0.2.0', 'annotated', { cwd: fx.dir });
    await push({ cwd: fx.dir, ref: 'main', followTags: false });
    const remoteTags = (await $`git tag`.cwd(bareDir).text()).trim();
    expect(remoteTags).not.toContain('v0.2.0');
  });
});

// ---------- resetHard ----------

describe('resetHard', () => {
  it('moves HEAD back to the given ref and discards later commits', async () => {
    fx.writeFile('a.txt', '1');
    const first = await fx.commit('chore: init');

    fx.writeFile('a.txt', '2');
    await fx.commit('feat: update');

    expect(await getHeadSha({ cwd: fx.dir })).not.toBe(first);

    await resetHard(first, { cwd: fx.dir });

    expect(await getHeadSha({ cwd: fx.dir })).toBe(first);
    expect(await isClean({ cwd: fx.dir })).toBe(true);
    // The a.txt content is back to the first commit's state.
    const exists = existsSync(join(fx.dir, 'a.txt'));
    expect(exists).toBe(true);
  });

  it('supports the CARET form used by undo (<sha>^)', async () => {
    fx.writeFile('a.txt', '1');
    const first = await fx.commit('chore: init');
    fx.writeFile('a.txt', '2');
    const second = await fx.commit('feat: update');

    // Reset to second^ should land on first.
    await resetHard(`${second}^`, { cwd: fx.dir });
    expect(await getHeadSha({ cwd: fx.dir })).toBe(first);
  });
});
