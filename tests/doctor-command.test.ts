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
    isGitRepo: () => true,
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
      ...passingDeps({ isGitRepo: () => false }),
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
