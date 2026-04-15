/**
 * End-to-end test for the full release flow.
 *
 * Creates a throwaway git repo with fixture commits, runs `runRelease`
 * with a mocked AI provider, and asserts the resulting version bump,
 * CHANGELOG, commit, tag, and transaction log are all correct.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRelease, type RunReleaseDeps } from '../../src/commands/release.ts';
import { readTransactionLog } from '../../src/core/rollback.ts';
import { getHeadSha, getLastTag, isClean } from '../../src/core/git.ts';
import type { AIGenerationResult, AIProvider } from '../../src/types.ts';
import { createGitFixture, type GitFixture } from '../helpers/git-fixture.ts';

// --------- Mock AI provider ---------

function mockProvider(): AIProvider {
  return {
    name: 'anthropic',
    defaultModel: 'mock',
    async generate(): Promise<AIGenerationResult> {
      return {
        text: '### Added\n\n- New feature for users\n\n### Fixed\n\n- Resolved a bug with input handling',
        inputTokens: 100,
        outputTokens: 50,
      };
    },
    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };
}

// --------- Fixture setup ---------

let fx: GitFixture;

beforeEach(async () => {
  fx = await createGitFixture();
  // Seed a package.json at v0.1.0.
  fx.writeFile(
    'package.json',
    JSON.stringify({ name: 'e2e-test-pkg', version: '0.1.0' }, null, 2) + '\n',
  );
  fx.writeFile('.gitignore', '.releasewise/\n');
  await fx.commit('chore: initial commit');
});

afterEach(() => {
  fx.cleanup();
});

function buildDeps(overrides?: Partial<RunReleaseDeps>): {
  deps: RunReleaseDeps;
  sinks: { stdout: string; stderr: string };
} {
  const sinks = { stdout: '', stderr: '' };
  const deps: RunReleaseDeps = {
    cwd: fx.dir,
    env: { ANTHROPIC_API_KEY: 'sk-fake-for-test' },
    stdout: (t: string) => {
      sinks.stdout += t;
    },
    stderr: (t: string) => {
      sinks.stderr += t;
    },
    getProvider: () => mockProvider(),
    ...overrides,
  };
  return { deps, sinks };
}

// --------- Tests ---------

describe('E2E: release flow', () => {
  it('performs a full release with conventional commits', async () => {
    // Create feature and fix commits.
    fx.writeFile('feature.ts', 'export const a = 1;');
    await fx.commit('feat: add new feature');
    fx.writeFile('fix.ts', 'export const b = 2;');
    await fx.commit('fix: resolve input handling bug');

    // Write a minimal config so loadConfig succeeds.
    fx.writeFile(
      '.releasewise.json',
      JSON.stringify({
        commitMode: 'mixed',
        ai: { provider: 'anthropic', model: 'mock' },
        release: { pushOnRelease: false, createGithubRelease: false },
      }) + '\n',
    );
    await fx.commit('chore: add releasewise config');

    const { deps, sinks } = buildDeps();
    const result = await runRelease({ yes: true }, deps);

    expect(result.exitCode).toBe(0);

    // Version bumped to 0.2.0 (minor, from feat commit).
    const pkg = JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('0.2.0');

    // Tag created.
    const tag = await getLastTag({ cwd: fx.dir });
    expect(tag).toBe('v0.2.0');

    // CHANGELOG written with AI-generated content.
    const changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [0.2.0]');
    expect(changelog).toContain('### Added');
    expect(changelog).toContain('New feature for users');

    // Working tree is clean (besides gitignored .releasewise/).
    expect(await isClean({ cwd: fx.dir })).toBe(true);

    // Transaction log written.
    const log = await readTransactionLog(fx.dir);
    expect(log).not.toBeNull();
    expect(log!.toVersion).toBe('0.2.0');
    expect(log!.pushed).toBe(false);

    // Output mentions the release.
    expect(sinks.stdout).toContain('v0.2.0');
  });

  it('default (no flags) previews and makes no changes', async () => {
    fx.writeFile('a.ts', 'export const a = 1;');
    await fx.commit('feat: add a');

    fx.writeFile(
      '.releasewise.json',
      JSON.stringify({
        commitMode: 'mixed',
        ai: { provider: 'anthropic', model: 'mock' },
        release: { pushOnRelease: false, createGithubRelease: false },
      }) + '\n',
    );
    await fx.commit('chore: add config');

    const headBefore = await getHeadSha({ cwd: fx.dir });
    const { deps, sinks } = buildDeps();
    // No --yes: must not mutate anything.
    const result = await runRelease({}, deps);

    expect(result.exitCode).toBe(0);
    expect(sinks.stdout).toContain('Release plan');
    expect(sinks.stdout).toContain('dry run');

    // HEAD hasn't changed — no commit was created.
    const headAfter = await getHeadSha({ cwd: fx.dir });
    expect(headAfter).toBe(headBefore);

    // No tag created.
    const tag = await getLastTag({ cwd: fx.dir });
    expect(tag).toBeNull();
  });

  it('--json produces valid JSON output', async () => {
    fx.writeFile('a.ts', 'export const a = 1;');
    await fx.commit('feat: add a');

    fx.writeFile(
      '.releasewise.json',
      JSON.stringify({
        commitMode: 'mixed',
        ai: { provider: 'anthropic', model: 'mock' },
        release: { pushOnRelease: false, createGithubRelease: false },
      }) + '\n',
    );
    await fx.commit('chore: add config');

    const { deps, sinks } = buildDeps();
    const result = await runRelease({ yes: true, json: true }, deps);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(sinks.stdout);
    expect(parsed.executed).toBe(true);
    expect(parsed.tagName).toBe('v0.2.0');
    expect(parsed.commitSha).toBeDefined();
  });

  it('--bump forces a specific bump type', async () => {
    fx.writeFile('a.ts', 'export const a = 1;');
    await fx.commit('fix: tiny fix');

    fx.writeFile(
      '.releasewise.json',
      JSON.stringify({
        commitMode: 'mixed',
        ai: { provider: 'anthropic', model: 'mock' },
        release: { pushOnRelease: false, createGithubRelease: false },
      }) + '\n',
    );
    await fx.commit('chore: add config');

    const { deps } = buildDeps();
    // Force major even though commits are only a fix.
    const result = await runRelease({ yes: true, bump: 'major' }, deps);

    expect(result.exitCode).toBe(0);
    const pkg = JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('1.0.0');
    expect(await getLastTag({ cwd: fx.dir })).toBe('v1.0.0');
  });

  it('--no-ai uses template fallback', async () => {
    fx.writeFile('a.ts', 'export const a = 1;');
    await fx.commit('feat: add feature a');

    fx.writeFile(
      '.releasewise.json',
      JSON.stringify({
        commitMode: 'conventional',
        ai: { provider: 'anthropic', model: 'mock' },
        release: { pushOnRelease: false, createGithubRelease: false },
      }) + '\n',
    );
    await fx.commit('chore: add config');

    const { deps } = buildDeps();
    const result = await runRelease({ yes: true, noAi: true }, deps);

    expect(result.exitCode).toBe(0);
    // Template fallback produces changelog with commit subjects.
    const changelog = readFileSync(join(fx.dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [0.2.0]');
  });
});
