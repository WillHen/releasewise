/**
 * `releasewise doctor` command.
 *
 * Runs a series of checks to verify the environment is set up correctly:
 * git repo, config valid, API key available, gh CLI installed.
 *
 * Testable core is `runDoctor()`; citty wrapper is `doctorCommand`.
 */
import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadConfig as realLoadConfig,
  type LoadedConfig,
} from '../core/config-loader.ts';
import {
  resolveApiKey as realResolveApiKey,
  type ResolvedApiKey,
} from '../core/config-resolver.ts';
import { isGitRepo as realIsGitRepo } from '../core/git.ts';

// --------- Public shape ---------

export interface RunDoctorDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  loadConfig?: (opts: { cwd?: string }) => LoadedConfig;
  resolveApiKey?: (
    config: LoadedConfig['config'],
    opts?: { env?: Record<string, string | undefined> },
  ) => ResolvedApiKey;
  isGitRepo?: (cwd: string) => Promise<boolean>;
  isGhInstalled?: () => Promise<boolean>;
}

export interface RunDoctorResult {
  exitCode: number;
  checks: DoctorCheck[];
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}

// --------- runDoctor ---------

export async function runDoctor(
  deps: RunDoctorDeps = {},
): Promise<RunDoctorResult> {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const loadConfig = deps.loadConfig ?? realLoadConfig;
  const resolveApiKey = deps.resolveApiKey ?? realResolveApiKey;
  const isGitRepo =
    deps.isGitRepo ?? ((dir: string) => realIsGitRepo({ cwd: dir }));
  const isGhInstalled = deps.isGhInstalled ?? defaultIsGhInstalled;

  const checks: DoctorCheck[] = [];

  // 1. Git repo
  if (await isGitRepo(cwd)) {
    checks.push({ name: 'Git repo', status: 'pass', message: 'Found' });
  } else {
    checks.push({
      name: 'Git repo',
      status: 'fail',
      message: 'Not a git repository',
    });
  }

  // 2. Config file
  let loadedConfig: LoadedConfig | null = null;
  try {
    loadedConfig = loadConfig({ cwd });
    checks.push({
      name: 'Config',
      status: 'pass',
      message: 'Valid .releasewise.json',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'Config', status: 'fail', message: msg });
  }

  // 3. API key
  if (loadedConfig) {
    try {
      const key = resolveApiKey(loadedConfig.config, { env });
      checks.push({
        name: 'API key',
        status: 'pass',
        message: `Found via ${key.source}`,
      });
    } catch {
      checks.push({
        name: 'API key',
        status: 'warn',
        message:
          'Not found. Set ANTHROPIC_API_KEY (or provider-specific env var)',
      });
    }
  } else {
    checks.push({
      name: 'API key',
      status: 'warn',
      message: 'Skipped (config not loaded)',
    });
  }

  // 4. gh CLI
  if (await isGhInstalled()) {
    checks.push({
      name: 'gh CLI',
      status: 'pass',
      message: 'Installed',
    });
  } else {
    checks.push({
      name: 'gh CLI',
      status: 'warn',
      message: 'Not found. GitHub Releases will use REST API fallback',
    });
  }

  // 5. package.json
  if (existsSync(join(cwd, 'package.json'))) {
    checks.push({
      name: 'package.json',
      status: 'pass',
      message: 'Found',
    });
  } else {
    checks.push({
      name: 'package.json',
      status: 'fail',
      message: 'Not found. releasewise requires package.json in v1',
    });
  }

  // Render
  const statusIcons = { pass: '+', fail: 'x', warn: '!' };
  for (const check of checks) {
    stdout(
      `  [${statusIcons[check.status]}] ${check.name}: ${check.message}\n`,
    );
  }

  const hasFail = checks.some((c) => c.status === 'fail');
  const exitCode = hasFail ? 1 : 0;

  stdout(
    hasFail
      ? '\nSome checks failed. Fix the issues above and re-run.\n'
      : '\nAll checks passed.\n',
  );

  return { exitCode, checks };
}

// --------- Default implementations ---------

async function defaultIsGhInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['gh', '--version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// --------- citty wrapper ---------

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description:
      'Verify setup: git repo, provider reachable, gh installed, config valid.',
  },
  async run() {
    const result = await runDoctor();
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
