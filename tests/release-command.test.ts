import { describe, expect, it } from 'bun:test';

import { defaultConfig, type Config } from '../src/core/config.ts';
import type { LoadedConfig } from '../src/core/config-loader.ts';
import type { ResolvedApiKey } from '../src/core/config-resolver.ts';
import type {
  CollectReleaseInputsOptions,
  ExecuteReleaseOptions,
  ExecuteReleaseResult,
  PlanReleaseOptions,
  ReleaseInputs,
  ReleasePlan,
} from '../src/core/orchestrator.ts';
import { runRelease, type RunReleaseDeps } from '../src/commands/release.ts';
import type { AIProvider, ClassifiedCommit, RemoteInfo } from '../src/types.ts';

// --------- Fixtures ---------

const github: RemoteInfo = {
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
};

function classified(partial: Partial<ClassifiedCommit>): ClassifiedCommit {
  return {
    sha: 'f'.repeat(40),
    shortSha: 'abc1234',
    subject: 'feat: add thing',
    body: '',
    author: 'Test',
    authorEmail: 'test@example.com',
    date: '2026-04-11T12:00:00Z',
    bump: 'minor',
    source: 'conventional',
    ...partial,
  };
}

function fakePlan(partial: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    baseRef: 'v1.2.2',
    headSha: 'deadbeef',
    firstRelease: false,
    currentVersion: '1.2.2',
    previousVersion: '1.2.2',
    nextVersion: '1.3.0',
    bump: 'minor',
    bumpForced: false,
    commits: [classified({ shortSha: 'aa1', subject: 'feat: add login' })],
    truncatedDiff: {
      content: 'diff body',
      originalTokens: 100,
      finalTokens: 100,
      truncated: false,
      droppedFiles: [],
      notes: [],
    },
    remote: github,
    notes: {
      title: 'v1.3.0',
      heading: '## [1.3.0] - 2026-04-11',
      body: '### Added\n- Add login (aa1)',
    },
    changelogPath: '/abs/path/CHANGELOG.md',
    changelogBefore: '',
    changelogAfter:
      '# Changelog\n\n## [1.3.0] - 2026-04-11\n\n### Added\n- Add login (aa1)\n',
    date: '2026-04-11',
    warnings: [],
    ...partial,
  };
}

function fakeLoaded(partial: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    config: defaultConfig(),
    baseConfigPath: '/abs/.releasewise.json',
    localConfigPath: null,
    warnings: [],
    ...partial,
  };
}

function fakeProvider(): AIProvider {
  return {
    name: 'anthropic',
    defaultModel: 'fake',
    estimateTokens: (s) => s.length,
    async generate() {
      return { text: 'fake', inputTokens: 1, outputTokens: 1 };
    },
  };
}

interface Sinks {
  stdout: string;
  stderr: string;
}

interface BuildDepsOptions {
  loadConfigImpl?: (opts: { cwd?: string }) => LoadedConfig;
  resolveApiKeyImpl?: (
    config: Config,
    opts?: { env?: Record<string, string | undefined> },
  ) => ResolvedApiKey;
  getProviderImpl?: (opts: { config: Config; apiKey: string }) => AIProvider;
  collectReleaseInputsImpl?: (
    opts: CollectReleaseInputsOptions,
  ) => Promise<ReleaseInputs>;
  planReleaseImpl?: (opts: PlanReleaseOptions) => Promise<ReleasePlan>;
  executeReleaseImpl?: (
    opts: ExecuteReleaseOptions,
  ) => Promise<ExecuteReleaseResult>;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

function buildDeps(opts: BuildDepsOptions = {}): {
  deps: RunReleaseDeps;
  sinks: Sinks;
  calls: Record<string, number>;
} {
  const sinks: Sinks = { stdout: '', stderr: '' };
  const calls = {
    loadConfig: 0,
    resolveApiKey: 0,
    getProvider: 0,
    collectReleaseInputs: 0,
    planRelease: 0,
    executeRelease: 0,
  };

  const deps: RunReleaseDeps = {
    cwd: '/tmp/fake',
    env: opts.env ?? { ANTHROPIC_API_KEY: 'sk-test' },
    isTTY: opts.isTTY ?? false,
    stdout: (t) => {
      sinks.stdout += t;
    },
    stderr: (t) => {
      sinks.stderr += t;
    },
    loadConfig: (o) => {
      calls.loadConfig++;
      return (opts.loadConfigImpl ?? (() => fakeLoaded()))(o);
    },
    resolveApiKey: (config, o) => {
      calls.resolveApiKey++;
      return (
        opts.resolveApiKeyImpl ??
        (() => ({ key: 'sk-test', source: 'explicit' as const }))
      )(config, o);
    },
    getProvider: (o) => {
      calls.getProvider++;
      return (opts.getProviderImpl ?? (() => fakeProvider()))(o);
    },
    collectReleaseInputs: async (o) => {
      calls.collectReleaseInputs++;
      if (opts.collectReleaseInputsImpl)
        return opts.collectReleaseInputsImpl(o);
      return {
        cwd: '/tmp/fake',
        headSha: 'deadbeef',
        baseRef: 'v1.2.2',
        firstRelease: false,
        currentVersion: '1.2.2',
        previousVersion: '1.2.2',
        commits: [],
        rawDiff: '',
        remote: github,
        existingChangelog: '',
        changelogPath: '/tmp/fake/CHANGELOG.md',
      };
    },
    planRelease: async (o) => {
      calls.planRelease++;
      if (opts.planReleaseImpl) return opts.planReleaseImpl(o);
      return fakePlan();
    },
    executeRelease: async (o) => {
      calls.executeRelease++;
      if (opts.executeReleaseImpl) return opts.executeReleaseImpl(o);
      return {
        version: o.plan.nextVersion,
        tagName: `v${o.plan.nextVersion}`,
        commitSha: 'a'.repeat(40),
        changelogPath: o.plan.changelogPath,
        pushed: !o.noPush && o.config.release.pushOnRelease,
        filesModified: ['package.json', 'CHANGELOG.md'],
        githubRelease: null,
      };
    },
  };

  return { deps, sinks, calls };
}

// --------- Dry-run vs execute ---------

describe('runRelease — dry-run vs execute', () => {
  it('runs the preview path when --dry-run is set', async () => {
    const { deps, sinks, calls } = buildDeps();
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(calls.executeRelease).toBe(0);
    expect(sinks.stdout.length).toBeGreaterThan(0);
    expect(sinks.stdout).toContain('Release plan (dry run)');
  });

  it('executes the release in non-TTY mode (implicit --yes)', async () => {
    const { deps, sinks, calls } = buildDeps({ isTTY: false });
    const result = await runRelease({}, deps);
    expect(result.exitCode).toBe(0);
    expect(calls.executeRelease).toBe(1);
    expect(sinks.stdout).toContain('Released v1.3.0');
  });

  it('executes the release with explicit --yes in TTY mode', async () => {
    const { deps, sinks, calls } = buildDeps({ isTTY: true });
    const result = await runRelease({ yes: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(calls.executeRelease).toBe(1);
    expect(sinks.stdout).toContain('Released v1.3.0');
  });

  it('omits dry-run markers in the execute-mode preview', async () => {
    const { deps, sinks } = buildDeps({ isTTY: false });
    const result = await runRelease({ yes: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(sinks.stdout).toContain('Release plan');
    expect(sinks.stdout).not.toContain('(dry run)');
    expect(sinks.stdout).not.toContain('This was a dry run');
  });

  it('refuses to execute in TTY mode without --yes', async () => {
    const { deps, sinks, calls } = buildDeps({ isTTY: true });
    const result = await runRelease({}, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('--yes');
    expect(calls.executeRelease).toBe(0);
  });

  it('renders JSON output when executing with --json', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ json: true, yes: true }, deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(sinks.stdout);
    expect(parsed.executed).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.commitSha).toBeDefined();
    expect(parsed.tagName).toBe('v1.3.0');
  });

  it('passes --no-push through to executeRelease', async () => {
    let capturedNoPush: boolean | undefined;
    const { deps } = buildDeps({
      executeReleaseImpl: async (o) => {
        capturedNoPush = o.noPush;
        return {
          version: o.plan.nextVersion,
          tagName: `v${o.plan.nextVersion}`,
          commitSha: 'a'.repeat(40),
          changelogPath: o.plan.changelogPath,
          pushed: false,
          filesModified: ['package.json', 'CHANGELOG.md'],
          githubRelease: null,
        };
      },
    });
    await runRelease({ noPush: true, yes: true }, deps);
    expect(capturedNoPush).toBe(true);
  });
});

// --------- Arg validation ---------

describe('runRelease — arg validation', () => {
  it('rejects invalid --bump with exit 1', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, bump: 'bogus' }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('--bump');
    expect(sinks.stderr).toContain('bogus');
  });

  it('accepts uppercase --bump values', async () => {
    const { deps } = buildDeps({
      planReleaseImpl: async (o) => {
        expect(o.forceBump).toBe('major');
        return fakePlan({ bump: 'major', bumpForced: true });
      },
    });
    const result = await runRelease({ dryRun: true, bump: 'MAJOR' }, deps);
    expect(result.exitCode).toBe(0);
  });

  it('rejects --mode manual with a helpful message', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, mode: 'manual' }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('manual');
    expect(sinks.stderr).toContain('--bump');
  });

  it('rejects invalid --mode', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, mode: 'random' }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('--mode');
  });

  it('rejects --pre with non-alphanumeric characters', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, pre: 'beta-1' }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('--pre');
  });

  it('accepts alphanumeric --pre', async () => {
    const { deps } = buildDeps({
      planReleaseImpl: async (o) => {
        expect(o.prerelease).toBe('beta');
        return fakePlan();
      },
    });
    const result = await runRelease({ dryRun: true, pre: 'beta' }, deps);
    expect(result.exitCode).toBe(0);
  });

  it('passes --from through as-is', async () => {
    const { deps } = buildDeps({
      collectReleaseInputsImpl: async (o) => {
        expect(o.fromRef).toBe('v1.0.0');
        return {
          cwd: '/tmp/fake',
          headSha: 'deadbeef',
          baseRef: 'v1.0.0',
          firstRelease: false,
          currentVersion: '1.2.2',
          previousVersion: '1.0.0',
          commits: [],
          rawDiff: '',
          remote: github,
          existingChangelog: '',
          changelogPath: '/tmp/fake/CHANGELOG.md',
        };
      },
    });
    const result = await runRelease({ dryRun: true, from: 'v1.0.0' }, deps);
    expect(result.exitCode).toBe(0);
  });
});

// --------- --tone validation ---------

describe('runRelease — tone', () => {
  it('rejects invalid --tone', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, tone: 'silly' }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('--tone');
  });

  it('passes valid --tone through to planRelease', async () => {
    let capturedTone: string | undefined;
    const { deps } = buildDeps({
      planReleaseImpl: async (o) => {
        capturedTone = o.tone;
        return fakePlan();
      },
    });
    const result = await runRelease({ dryRun: true, tone: 'casual' }, deps);
    expect(result.exitCode).toBe(0);
    expect(capturedTone).toBe('casual');
  });
});

// --------- --estimate ---------

describe('runRelease — estimate', () => {
  it('prints token estimate and exits without calling AI or executing', async () => {
    const { deps, sinks, calls } = buildDeps();
    const result = await runRelease({ estimate: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(sinks.stdout).toContain('Token estimate');
    expect(sinks.stdout).toContain('Input tokens');
    expect(calls.planRelease).toBe(0);
    expect(calls.executeRelease).toBe(0);
  });

  it('prints JSON when --estimate --json', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ estimate: true, json: true }, deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(sinks.stdout);
    expect(parsed.inputTokensEstimate).toBeGreaterThanOrEqual(0);
    expect(parsed.maxOutputTokens).toBeDefined();
  });
});

// --------- Provider wiring ---------

describe('runRelease — provider wiring', () => {
  it('builds the provider by default and passes it to planRelease', async () => {
    let receivedProvider: AIProvider | null | undefined;
    const { deps, calls } = buildDeps({
      planReleaseImpl: async (o) => {
        receivedProvider = o.provider;
        return fakePlan();
      },
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(calls.resolveApiKey).toBe(1);
    expect(calls.getProvider).toBe(1);
    expect(receivedProvider).not.toBeNull();
  });

  it('skips provider construction when --no-ai is set', async () => {
    let receivedProvider: AIProvider | null | undefined;
    const { deps, calls } = buildDeps({
      planReleaseImpl: async (o) => {
        receivedProvider = o.provider;
        return fakePlan();
      },
    });
    const result = await runRelease({ dryRun: true, noAi: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(calls.resolveApiKey).toBe(0);
    expect(calls.getProvider).toBe(0);
    expect(receivedProvider).toBeNull();
  });

  it('surfaces missing API key errors on stderr with exit 1', async () => {
    const { deps, sinks } = buildDeps({
      resolveApiKeyImpl: () => {
        throw new Error('No API key for provider "anthropic".');
      },
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('No API key');
  });
});

// --------- Config + warnings ---------

describe('runRelease — config + warnings', () => {
  it('surfaces config load errors on stderr with exit 1', async () => {
    const { deps, sinks } = buildDeps({
      loadConfigImpl: () => {
        throw new Error('No .releasewise.json found');
      },
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('No .releasewise.json');
  });

  it('merges loader warnings in front of plan warnings', async () => {
    const { deps, sinks } = buildDeps({
      loadConfigImpl: () => fakeLoaded({ warnings: ['loader warning'] }),
      planReleaseImpl: async () => fakePlan({ warnings: ['plan warning'] }),
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(0);
    const loaderIdx = sinks.stdout.indexOf('loader warning');
    const planIdx = sinks.stdout.indexOf('plan warning');
    expect(loaderIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    expect(loaderIdx).toBeLessThan(planIdx);
  });
});

// --------- Rendering ---------

describe('runRelease — rendering', () => {
  it('renders human preview by default', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(sinks.stdout).toContain('Release plan (dry run)');
    expect(sinks.stdout).toContain('1.2.2 -> 1.3.0');
    expect(sinks.stdout).toContain('This was a dry run');
  });

  it('renders JSON preview when --json is set', async () => {
    const { deps, sinks } = buildDeps();
    const result = await runRelease({ dryRun: true, json: true }, deps);
    expect(result.exitCode).toBe(0);
    // Output should be parseable JSON.
    const parsed = JSON.parse(sinks.stdout.trim());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.nextVersion).toBe('1.3.0');
    expect(parsed.bump).toBe('minor');
    // Should NOT contain the human preview header.
    expect(sinks.stdout).not.toContain('Release plan (dry run)');
  });

  it('trailing newline on human output', async () => {
    const { deps, sinks } = buildDeps();
    await runRelease({ dryRun: true }, deps);
    expect(sinks.stdout.endsWith('\n')).toBe(true);
  });
});

// --------- Error handling ---------

describe('runRelease — error handling', () => {
  it('catches planRelease errors and writes message to stderr', async () => {
    const { deps, sinks } = buildDeps({
      planReleaseImpl: async () => {
        throw new Error(
          'No commits in range v1.2.2..HEAD — nothing to release.',
        );
      },
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('nothing to release');
  });

  it('handles non-Error throws', async () => {
    const { deps, sinks } = buildDeps({
      planReleaseImpl: async () => {
        throw 'string thrown';
      },
    });
    const result = await runRelease({ dryRun: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(sinks.stderr).toContain('string thrown');
  });
});
