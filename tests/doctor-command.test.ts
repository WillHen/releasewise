import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor, type RunDoctorDeps } from '../src/commands/doctor.ts';
import { defaultConfig } from '../src/core/config.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'releasewise-doctor-'));
  // Seed a package.json so the check passes by default.
  writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function capture() {
  let stdout = '';
  return {
    stdout: (t: string) => {
      stdout += t;
    },
    get out() {
      return stdout;
    },
  };
}

function passingDeps(overrides?: Partial<RunDoctorDeps>): RunDoctorDeps {
  return {
    cwd: tmpDir,
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    isGitRepo: async () => true,
    isGhInstalled: async () => true,
    loadConfig: () => ({
      config: defaultConfig(),
      warnings: [],
      baseConfigPath: '/fake/.releasewise.json',
      localConfigPath: null,
    }),
    resolveApiKey: () => ({
      key: 'sk-test',
      source: 'provider-env' as const,
      envVarName: 'ANTHROPIC_API_KEY',
    }),
    ...overrides,
  };
}

describe('runDoctor', () => {
  it('passes all checks in a healthy environment', async () => {
    const sinks = capture();
    const result = await runDoctor({ ...passingDeps(), ...sinks });

    expect(result.exitCode).toBe(0);
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(sinks.out).toContain('All checks passed');
  });

  it('fails when not a git repo', async () => {
    const sinks = capture();
    const result = await runDoctor({
      ...passingDeps({ isGitRepo: async () => false }),
      ...sinks,
    });

    expect(result.exitCode).toBe(1);
    const gitCheck = result.checks.find((c) => c.name === 'Git repo');
    expect(gitCheck?.status).toBe('fail');
  });

  it('fails when config is invalid', async () => {
    const sinks = capture();
    const result = await runDoctor({
      ...passingDeps({
        loadConfig: () => {
          throw new Error('Invalid config');
        },
      }),
      ...sinks,
    });

    expect(result.exitCode).toBe(1);
    const configCheck = result.checks.find((c) => c.name === 'Config');
    expect(configCheck?.status).toBe('fail');
    expect(configCheck?.message).toContain('Invalid config');
  });

  it('warns when API key is missing', async () => {
    const sinks = capture();
    const result = await runDoctor({
      ...passingDeps({
        resolveApiKey: () => {
          throw new Error('No key');
        },
      }),
      ...sinks,
    });

    // Missing API key is a warning, not a failure.
    expect(result.exitCode).toBe(0);
    const keyCheck = result.checks.find((c) => c.name === 'API key');
    expect(keyCheck?.status).toBe('warn');
  });

  it('warns when gh is not installed', async () => {
    const sinks = capture();
    const result = await runDoctor({
      ...passingDeps({ isGhInstalled: async () => false }),
      ...sinks,
    });

    expect(result.exitCode).toBe(0);
    const ghCheck = result.checks.find((c) => c.name === 'gh CLI');
    expect(ghCheck?.status).toBe('warn');
    expect(ghCheck?.message).toContain('REST API fallback');
  });

  it('fails when package.json is missing', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'releasewise-doctor-nopkg-'));
    const sinks = capture();
    const result = await runDoctor({
      ...passingDeps({ cwd: emptyDir }),
      ...sinks,
    });

    const pkgCheck = result.checks.find((c) => c.name === 'package.json');
    expect(pkgCheck?.status).toBe('fail');
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('detects a git worktree (where .git is a file, not a directory)', async () => {
    // Real repo on disk: init, make a commit, then add a worktree. The
    // worktree's `.git` is a regular file containing `gitdir: <path>`.
    // The old filesystem-only check (existsSync(".git") — statable but
    // that's fine) used to return true for this too, but the point of
    // the fix is to drop the filesystem heuristic entirely in favor of
    // `git rev-parse --is-inside-work-tree`. Exercise the default path
    // (no isGitRepo override) to verify.
    const mainRepo = mkdtempSync(join(tmpdir(), 'releasewise-wt-main-'));
    const wtDir = mkdtempSync(join(tmpdir(), 'releasewise-wt-leaf-'));
    // mkdtemp made wtDir as an existing directory — remove it so `git
    // worktree add` can create it fresh.
    rmSync(wtDir, { recursive: true, force: true });

    try {
      await $`git init -b main`.cwd(mainRepo).quiet();
      writeFileSync(join(mainRepo, 'a.txt'), 'x');
      await $`git -c user.name=t -c user.email=t@x -c commit.gpgsign=false add a.txt`
        .cwd(mainRepo)
        .quiet();
      await $`git -c user.name=t -c user.email=t@x -c commit.gpgsign=false commit -m init`
        .cwd(mainRepo)
        .quiet();
      await $`git worktree add -b wt-branch ${wtDir}`.cwd(mainRepo).quiet();
      writeFileSync(join(wtDir, 'package.json'), '{"name":"wt"}');

      const sinks = capture();
      const result = await runDoctor({
        cwd: wtDir,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        // Note: no isGitRepo override — exercises the real default.
        isGhInstalled: async () => true,
        loadConfig: () => ({
          config: defaultConfig(),
          warnings: [],
          baseConfigPath: '/fake/.releasewise.json',
          localConfigPath: null,
        }),
        resolveApiKey: () => ({
          key: 'sk-test',
          source: 'provider-env' as const,
          envVarName: 'ANTHROPIC_API_KEY',
        }),
        ...sinks,
      });

      const gitCheck = result.checks.find((c) => c.name === 'Git repo');
      expect(gitCheck?.status).toBe('pass');
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
      rmSync(mainRepo, { recursive: true, force: true });
    }
  });

  it('renders status icons correctly', async () => {
    const sinks = capture();
    await runDoctor({
      ...passingDeps({ isGhInstalled: async () => false }),
      ...sinks,
    });

    expect(sinks.out).toContain('[+]'); // pass
    expect(sinks.out).toContain('[!]'); // warn
  });
});
