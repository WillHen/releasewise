import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectReleaseInputs,
  executeRelease,
  planRelease,
  type ReleasePlan,
} from '../src/core/orchestrator.ts';
import { defaultConfig, type Config } from '../src/core/config.ts';
import { getHeadSha, getLastTag, isClean } from '../src/core/git.ts';
import {
  readTransactionLog,
  transactionLogPath,
} from '../src/core/rollback.ts';
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

  it('dirty-tree refusal throws a ReleaseError with RELEASE_DIRTY', async () => {
    seedPackageJson();
    await fx.commit('chore: init');
    fx.writeFile('package.json', '{ "name": "dirty" }');
    await $`git add package.json`.cwd(fx.dir).quiet();

    const plan = buildPlan();
    let caught: unknown;
    try {
      await executeRelease({
        plan,
        config: config(),
        cwd: fx.dir,
        noPush: true,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('ERR_RELEASE_DIRTY');
    expect((caught as { step?: string }).step).toBe('preflight');
    expect((caught as { hint?: string }).hint).toBeTruthy();
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

  // Partial-failure recovery: if push (or any post-commit step) fails, the
  // on-disk transaction log must still describe the local mutations so
  // `releasewise undo` can clean them up.
  it('writes a transaction log describing the local commit + tag when push fails', async () => {
    seedPackageJson();
    await fx.commit('chore: init');
    // Intentionally no remote — `git push` will fail mid-release.

    const plan = buildPlan();
    const cfg = config();
    cfg.release.pushOnRelease = true;

    await expect(
      executeRelease({ plan, config: cfg, cwd: fx.dir }),
    ).rejects.toMatchObject({ code: 'ERR_GIT_PUSH_FAILED' });

    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.fromVersion).toBe('0.1.0');
    expect(log!.toVersion).toBe('1.0.0');
    expect(log!.bumpCommitSha).toBe(await getHeadSha({ cwd: fx.dir }));
    expect(log!.tagName).toBe('v1.0.0');
    expect(log!.pushed).toBe(false);
    expect(log!.githubReleaseId).toBeNull();
  });

  it('writes a transaction log with tagName: null when tag creation fails', async () => {
    seedPackageJson();
    await fx.commit('chore: init');
    // Pre-create a tag with the same name the release will try to use,
    // so `git tag` refuses with a duplicate-tag error mid-release.
    await fx.tag('v1.0.0');

    const plan = buildPlan();
    await expect(
      executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true }),
    ).rejects.toMatchObject({ code: 'ERR_GIT_TAG_FAILED' });

    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.bumpCommitSha).toBe(await getHeadSha({ cwd: fx.dir }));
    expect(log!.tagName).toBeNull();
    expect(log!.pushed).toBe(false);
  });

  // The log file is a single snapshot — the latest write wins. A regression
  // here would mean multiple successive writes accumulated in the file
  // (corrupt JSON) instead of overwriting.
  it('transaction log is overwritten, not appended, across the release', async () => {
    seedPackageJson();
    await fx.commit('chore: init');

    const plan = buildPlan();
    await executeRelease({ plan, config: config(), cwd: fx.dir, noPush: true });

    const raw = readFileSync(transactionLogPath(fx.dir), 'utf8');
    // A single JSON object, not concatenated — must parse cleanly and
    // contain exactly one timestamp field.
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.match(/"timestamp":/g)).toHaveLength(1);
  });
});

// --------- Prerelease graduation E2E ---------

/**
 * Walk a fixture repo through the full prerelease graduation cycle:
 *   0.1.0  --bump major --pre alpha  → 1.0.0-alpha.0
 *   alpha  --bump patch --pre beta   → 1.0.0-beta.0   (label switch)
 *   beta   (no --pre)                → 1.0.0          (graduation)
 *
 * Drives the real `collectReleaseInputs → planRelease → executeRelease`
 * pipeline with a null provider (template notes) so no AI is involved.
 * Asserts package.json, CHANGELOG, and the annotated tag for each step.
 */
describe('executeRelease — prerelease graduation alpha.0 → beta.0 → 1.0.0', () => {
  it('cycles through alpha, beta, and graduates to the stable version', async () => {
    seedPackageJson('0.1.0');
    await fx.commit('chore: init');

    const cfg = config();
    // Keep the test hermetic: never push, never hit GitHub.
    cfg.release.pushOnRelease = false;
    cfg.release.createGithubRelease = false;

    // --- Step 1: 0.1.0 → 1.0.0-alpha.0 ---
    fx.writeFile('src/a.ts', 'export const a = 1;\n');
    await fx.commit('feat!: overhaul public API');

    const step1Inputs = await collectReleaseInputs({
      cwd: fx.dir,
      config: cfg,
    });
    expect(step1Inputs.currentVersion).toBe('0.1.0');
    expect(step1Inputs.previousVersion).toBeNull();

    const step1Plan = await planRelease({
      inputs: step1Inputs,
      config: cfg,
      provider: null,
      forceBump: 'major',
      prerelease: 'alpha',
      date: '2026-04-14',
    });
    expect(step1Plan.nextVersion).toBe('1.0.0-alpha.0');

    const step1Result = await executeRelease({
      plan: step1Plan,
      config: cfg,
      cwd: fx.dir,
      noPush: true,
    });

    expect(step1Result.version).toBe('1.0.0-alpha.0');
    expect(step1Result.tagName).toBe('v1.0.0-alpha.0');
    expect(await getLastTag({ cwd: fx.dir })).toBe('v1.0.0-alpha.0');
    expect(
      JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8')).version,
    ).toBe('1.0.0-alpha.0');
    let changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.0-alpha.0]');
    expect(await isClean({ cwd: fx.dir })).toBe(true);

    // --- Step 2: 1.0.0-alpha.0 → 1.0.0-beta.0 (label switch) ---
    fx.writeFile('src/b.ts', 'export const b = 2;\n');
    await fx.commit('fix: stabilize alpha behavior');

    const step2Inputs = await collectReleaseInputs({
      cwd: fx.dir,
      config: cfg,
    });
    expect(step2Inputs.currentVersion).toBe('1.0.0-alpha.0');
    expect(step2Inputs.previousVersion).toBe('1.0.0-alpha.0');

    const step2Plan = await planRelease({
      inputs: step2Inputs,
      config: cfg,
      provider: null,
      forceBump: 'patch',
      prerelease: 'beta',
      date: '2026-04-14',
    });
    expect(step2Plan.nextVersion).toBe('1.0.0-beta.0');

    const step2Result = await executeRelease({
      plan: step2Plan,
      config: cfg,
      cwd: fx.dir,
      noPush: true,
    });

    expect(step2Result.version).toBe('1.0.0-beta.0');
    expect(step2Result.tagName).toBe('v1.0.0-beta.0');
    expect(await getLastTag({ cwd: fx.dir })).toBe('v1.0.0-beta.0');
    expect(
      JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8')).version,
    ).toBe('1.0.0-beta.0');
    changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    // Both the alpha and beta entries must be present (newest first).
    expect(changelog).toContain('## [1.0.0-beta.0]');
    expect(changelog).toContain('## [1.0.0-alpha.0]');
    expect(changelog.indexOf('[1.0.0-beta.0]')).toBeLessThan(
      changelog.indexOf('[1.0.0-alpha.0]'),
    );
    expect(await isClean({ cwd: fx.dir })).toBe(true);

    // --- Step 3: 1.0.0-beta.0 → 1.0.0 (graduation) ---
    fx.writeFile('src/c.ts', 'export const c = 3;\n');
    await fx.commit('fix: polish beta before GA');

    const step3Inputs = await collectReleaseInputs({
      cwd: fx.dir,
      config: cfg,
    });
    expect(step3Inputs.currentVersion).toBe('1.0.0-beta.0');
    expect(step3Inputs.previousVersion).toBe('1.0.0-beta.0');

    const step3Plan = await planRelease({
      inputs: step3Inputs,
      config: cfg,
      provider: null,
      forceBump: 'patch',
      // No prerelease here — patch + prior prerelease → graduation.
      date: '2026-04-14',
    });
    expect(step3Plan.nextVersion).toBe('1.0.0');

    const step3Result = await executeRelease({
      plan: step3Plan,
      config: cfg,
      cwd: fx.dir,
      noPush: true,
    });

    expect(step3Result.version).toBe('1.0.0');
    expect(step3Result.tagName).toBe('v1.0.0');
    expect(await getLastTag({ cwd: fx.dir })).toBe('v1.0.0');
    expect(
      JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8')).version,
    ).toBe('1.0.0');
    changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.0] - 2026-04-14');
    // All three headings are present and in the right order (newest first).
    const gaIdx = changelog.indexOf('## [1.0.0]');
    const betaIdx = changelog.indexOf('## [1.0.0-beta.0]');
    const alphaIdx = changelog.indexOf('## [1.0.0-alpha.0]');
    expect(gaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(gaIdx);
    expect(alphaIdx).toBeGreaterThan(betaIdx);
    expect(await isClean({ cwd: fx.dir })).toBe(true);

    // Transaction log reflects the final graduation.
    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.fromVersion).toBe('1.0.0-beta.0');
    expect(log!.toVersion).toBe('1.0.0');
    expect(log!.tagName).toBe('v1.0.0');
  });
});
