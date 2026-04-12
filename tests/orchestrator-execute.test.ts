import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { executeRelease, type ReleasePlan } from '../src/core/orchestrator.ts';
import { defaultConfig, type Config } from '../src/core/config.ts';
import { getHeadSha, getLastTag, isClean } from '../src/core/git.ts';
import { readTransactionLog } from '../src/core/rollback.ts';
import type { ReleaseNotes } from '../src/types.ts';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.ts';

// --------- Fixture helpers ---------

let fx: GitFixture;

beforeEach(async () => {
  fx = await createGitFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Minimal package.json for a v0.1.0 project. Also adds .gitignore for .releasewise/. */
function seedPackageJson(version = '0.1.0'): void {
  fx.writeFile('.gitignore', '.releasewise/\n');
  fx.writeFile(
    'package.json',
    JSON.stringify({ name: 'test-pkg', version }, null, 2) + '\n',
  );
}

/** Build a minimal ReleasePlan for testing the write path. */
function buildPlan(overrides?: Partial<ReleasePlan>): ReleasePlan {
  const notes: ReleaseNotes = {
    title: 'v1.0.0',
    heading: '## [1.0.0] - 2026-04-12',
    body: '### Added\n\n- Something new',
  };
  return {
    baseRef: 'abc1234',
    headSha: 'def5678',
    firstRelease: true,
    currentVersion: '0.1.0',
    previousVersion: null,
    nextVersion: '1.0.0',
    bump: 'major',
    bumpForced: false,
    commits: [],
    truncatedDiff: {
      content: '',
      droppedFiles: [],
      originalTokens: 0,
      finalTokens: 0,
      truncated: false,
      notes: [],
    },
    remote: null,
    notes,
    changelogPath: join(fx.dir, 'CHANGELOG.md'),
    changelogBefore: '',
    changelogAfter: `# Changelog\n\n${notes.heading}\n\n${notes.body}\n`,
    date: '2026-04-12',
    warnings: [],
    ...overrides,
  };
}

function config(overrides?: Partial<Config>): Config {
  return { ...defaultConfig(), ...overrides };
}

// --------- Tests ---------

describe('executeRelease', () => {
  it('writes package.json with the new version', async () => {
    seedPackageJson('0.1.0');
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    const pkg = JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('1.0.0');
  });

  it('writes CHANGELOG.md with the new entry', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    const changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.0] - 2026-04-12');
    expect(changelog).toContain('### Added');
    expect(changelog).toContain('- Something new');
  });

  it('creates a commit with the configured message template', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    const log = await $`git log -1 --format=%s`.cwd(fx.dir).text();
    expect(log.trim()).toBe('chore(release): v1.0.0');
  });

  it('creates an annotated tag with the configured prefix', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    const tag = await getLastTag({ cwd: fx.dir });
    expect(tag).toBe('v1.0.0');
  });

  it('uses a custom tag prefix from config', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const cfg = config();
    cfg.release.tagPrefix = 'release-';
    await executeRelease({ plan, config: cfg, cwd: fx.dir, noPush: true });

    const tag = await getLastTag({ cwd: fx.dir });
    expect(tag).toBe('release-1.0.0');
  });

  it('uses a custom commit message from config', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const cfg = config();
    cfg.release.commitMessage = 'release: ${version}';
    await executeRelease({ plan, config: cfg, cwd: fx.dir, noPush: true });

    const log = await $`git log -1 --format=%s`.cwd(fx.dir).text();
    expect(log.trim()).toBe('release: 1.0.0');
  });

  it('returns the correct result shape', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const result = await executeRelease({
      plan,
      config: config(),
      cwd: fx.dir,
      noPush: true,
    });

    expect(result.version).toBe('1.0.0');
    expect(result.tagName).toBe('v1.0.0');
    expect(result.commitSha).toHaveLength(40);
    expect(result.changelogPath).toBe(plan.changelogPath);
    expect(result.pushed).toBe(false);
    expect(result.filesModified).toContain('package.json');
    expect(result.filesModified).toContain('CHANGELOG.md');
  });

  it('leaves the working tree clean after execution', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    expect(await isClean({ cwd: fx.dir })).toBe(true);
  });

  it('the release commit SHA is the new HEAD', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const result = await executeRelease({
      plan,
      config: config(),
      cwd: fx.dir,
      noPush: true,
    });

    const head = await getHeadSha({ cwd: fx.dir });
    expect(result.commitSha).toBe(head);
  });

  it('refuses to run if package.json has uncommitted changes', async () => {
    seedPackageJson();
    await fx.commit('chore: init');
    // Dirty package.json after the initial commit.
    fx.writeFile('package.json', '{ "name": "dirty" }');
    await $`git add package.json`.cwd(fx.dir).quiet();

    const plan = buildPlan();
    await expect(
      executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true }),
    ).rejects.toThrow('package.json has uncommitted changes');
  });

  it('refuses to run if CHANGELOG.md has uncommitted changes', async () => {
    seedPackageJson();
    fx.writeFile('CHANGELOG.md', 'existing');
    await fx.commit('chore: init');
    // Dirty the changelog.
    fx.writeFile('CHANGELOG.md', 'modified');
    await $`git add CHANGELOG.md`.cwd(fx.dir).quiet();

    const plan = buildPlan();
    await expect(
      executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true }),
    ).rejects.toThrow('CHANGELOG.md has uncommitted changes');
  });

  it('noPush prevents git push even when config says pushOnRelease', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const cfg = config();
    cfg.release.pushOnRelease = true;
    const result = await executeRelease({
      plan,
      config: cfg,
      cwd: fx.dir,
      noPush: true,
    });

    expect(result.pushed).toBe(false);
  });

  it('respects pushOnRelease: false in config', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const cfg = config();
    cfg.release.pushOnRelease = false;
    const result = await executeRelease({
      plan,
      config: cfg,
      cwd: fx.dir,
      // noPush not set — but config says don't push.
    });

    expect(result.pushed).toBe(false);
  });

  it('writes a transaction log after release', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    const result = await executeRelease({
      plan,
      config: config(),
      cwd: fx.dir,
      noPush: true,
    });

    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.fromVersion).toBe('0.1.0');
    expect(log!.toVersion).toBe('1.0.0');
    expect(log!.tagName).toBe('v1.0.0');
    expect(log!.bumpCommitSha).toBe(result.commitSha);
    expect(log!.pushed).toBe(false);
    expect(log!.filesModified).toContain('package.json');
  });

  it('transaction log records pushed: true when push is enabled', async () => {
    seedPackageJson();
    await fx.commit('chore: init');
    // Add a bare remote and push the initial commit to set up tracking.
    const remoteDir = `${fx.dir}-remote`;
    await $`git init --bare ${remoteDir}`.quiet();
    await $`git remote add origin ${remoteDir}`.cwd(fx.dir).quiet();
    await $`git push -u origin main`.cwd(fx.dir).quiet();

    const plan = buildPlan();
    const cfg = config();
    cfg.release.pushOnRelease = true;
    await executeRelease({ plan, config: cfg, cwd: fx.dir });

    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.pushed).toBe(true);
  });
});
