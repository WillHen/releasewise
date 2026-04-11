import { describe, expect, it } from 'bun:test';

import { configSchema, defaultConfig } from '../src/core/config.ts';

describe('defaultConfig()', () => {
  it('returns a fully-resolved config with sensible defaults', () => {
    const cfg = defaultConfig();

    expect(cfg.commitMode).toBe('mixed');
    expect(cfg.language).toBe('en');

    expect(cfg.ai.provider).toBe('anthropic');
    expect(cfg.ai.model).toBe('claude-haiku-4-5');
    expect(cfg.ai.maxDiffTokens).toBe(8000);
    expect(cfg.ai.maxOutputTokens).toBe(2000);
    expect(cfg.ai.temperature).toBe(0.4);
    expect(cfg.ai.apiKey).toBeUndefined();

    expect(cfg.changelog.format).toBe('changelog');
    expect(cfg.changelog.path).toBe('CHANGELOG.md');
    expect(cfg.changelog.individualDir).toBe('docs/releases');

    expect(cfg.release.tagPrefix).toBe('v');
    expect(cfg.release.commitMessage).toBe('chore(release): v${version}');
    expect(cfg.release.pushOnRelease).toBe(true);
    expect(cfg.release.createGithubRelease).toBe(true);
    expect(cfg.release.tone).toBe('technical');
  });
});

describe('configSchema — accepts', () => {
  it('an empty object (all defaults)', () => {
    const parsed = configSchema.parse({});
    expect(parsed).toEqual(defaultConfig());
  });

  it('the full example from the plan', () => {
    const parsed = configSchema.parse({
      $schema: 'https://releasewise.dev/schema/v1.json',
      projectName: 'my-app',
      commitMode: 'mixed',
      ai: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        maxDiffTokens: 8000,
      },
      changelog: {
        format: 'changelog',
        path: 'CHANGELOG.md',
      },
      release: {
        tagPrefix: 'v',
        commitMessage: 'chore(release): v${version}',
        pushOnRelease: true,
        createGithubRelease: true,
        tone: 'technical',
      },
      language: 'en',
    });
    expect(parsed.projectName).toBe('my-app');
    expect(parsed.ai.provider).toBe('anthropic');
    expect(parsed.ai.maxDiffTokens).toBe(8000);
  });

  it('a partial override that fills defaults for unset fields', () => {
    const parsed = configSchema.parse({
      ai: { provider: 'openai' },
    });
    expect(parsed.ai.provider).toBe('openai');
    // Unset fields still populated from schema defaults.
    expect(parsed.ai.model).toBe('claude-haiku-4-5');
    expect(parsed.commitMode).toBe('mixed');
  });
});

describe('configSchema — rejects', () => {
  it('an unknown commitMode', () => {
    const result = configSchema.safeParse({ commitMode: 'yolo' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['commitMode']);
    }
  });

  it('an unknown provider', () => {
    const result = configSchema.safeParse({ ai: { provider: 'llama' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['ai', 'provider']);
    }
  });

  it('zero or negative maxDiffTokens', () => {
    expect(configSchema.safeParse({ ai: { maxDiffTokens: 0 } }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ ai: { maxDiffTokens: -10 } }).success).toBe(
      false,
    );
  });

  it('fractional maxDiffTokens', () => {
    expect(configSchema.safeParse({ ai: { maxDiffTokens: 1.5 } }).success).toBe(
      false,
    );
  });

  it('temperature outside [0, 2]', () => {
    expect(configSchema.safeParse({ ai: { temperature: -0.1 } }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ ai: { temperature: 2.1 } }).success).toBe(
      false,
    );
  });

  it('a non-URL baseUrl', () => {
    const result = configSchema.safeParse({
      ai: { baseUrl: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('an empty projectName', () => {
    const result = configSchema.safeParse({ projectName: '' });
    expect(result.success).toBe(false);
  });

  it('an unknown changelog format', () => {
    const result = configSchema.safeParse({
      changelog: { format: 'rss' },
    });
    expect(result.success).toBe(false);
  });

  it('an unknown tone', () => {
    const result = configSchema.safeParse({
      release: { tone: 'snarky' },
    });
    expect(result.success).toBe(false);
  });
});
