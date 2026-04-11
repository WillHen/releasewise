import { describe, expect, it } from 'bun:test';

import { defaultConfig, type Config } from '../src/core/config.ts';
import {
  MissingApiKeyError,
  PROVIDER_ENV_VARS,
  resolveApiKey,
} from '../src/core/config-resolver.ts';
import type { ProviderName } from '../src/types.ts';

/** Helper: build a Config with a given provider + optional file-stored key. */
function configWith(provider: ProviderName, apiKey?: string): Config {
  const base = defaultConfig();
  return {
    ...base,
    ai: { ...base.ai, provider, ...(apiKey ? { apiKey } : {}) },
  };
}

describe('resolveApiKey — precedence', () => {
  it('explicit CLI flag wins over every other source', () => {
    const cfg = configWith('anthropic', 'from-file');
    const result = resolveApiKey(cfg, {
      explicit: 'from-flag',
      env: { ANTHROPIC_API_KEY: 'from-env' },
    });
    expect(result).toEqual({ key: 'from-flag', source: 'explicit' });
  });

  it('provider env var wins over a file-stored key', () => {
    const cfg = configWith('anthropic', 'from-file');
    const result = resolveApiKey(cfg, {
      env: { ANTHROPIC_API_KEY: 'from-env' },
    });
    expect(result).toEqual({
      key: 'from-env',
      source: 'provider-env',
      envVarName: 'ANTHROPIC_API_KEY',
    });
  });

  it('file-stored key is used when no env var is set', () => {
    const cfg = configWith('openai', 'from-file');
    const result = resolveApiKey(cfg, { env: {} });
    expect(result).toEqual({ key: 'from-file', source: 'config-file' });
  });
});

describe('resolveApiKey — per provider', () => {
  const providers: ProviderName[] = ['anthropic', 'openai', 'groq', 'gemini'];

  for (const provider of providers) {
    it(`reads ${PROVIDER_ENV_VARS[provider]} for provider=${provider}`, () => {
      const cfg = configWith(provider);
      const result = resolveApiKey(cfg, {
        env: { [PROVIDER_ENV_VARS[provider]]: `key-for-${provider}` },
      });
      expect(result.key).toBe(`key-for-${provider}`);
      expect(result.source).toBe('provider-env');
      expect(result.envVarName).toBe(PROVIDER_ENV_VARS[provider]);
    });

    it(`does not pick up a different provider's env var for ${provider}`, () => {
      // Set every OTHER provider's env var, make sure none leak through.
      const env: Record<string, string> = {};
      for (const other of providers) {
        if (other !== provider) env[PROVIDER_ENV_VARS[other]] = 'wrong';
      }
      const cfg = configWith(provider);
      expect(() => resolveApiKey(cfg, { env })).toThrow(MissingApiKeyError);
    });
  }
});

describe('resolveApiKey — edge cases', () => {
  it('empty explicit string falls through to the next source', () => {
    const cfg = configWith('anthropic');
    const result = resolveApiKey(cfg, {
      explicit: '',
      env: { ANTHROPIC_API_KEY: 'from-env' },
    });
    expect(result.source).toBe('provider-env');
  });

  it('empty env var value falls through to file key', () => {
    const cfg = configWith('anthropic', 'from-file');
    const result = resolveApiKey(cfg, {
      env: { ANTHROPIC_API_KEY: '' },
    });
    expect(result).toEqual({ key: 'from-file', source: 'config-file' });
  });

  it('throws MissingApiKeyError when nothing is set', () => {
    const cfg = configWith('anthropic');
    expect(() => resolveApiKey(cfg, { env: {} })).toThrow(MissingApiKeyError);
  });

  it('error message names the provider, env var, and remediation paths', () => {
    const cfg = configWith('groq');
    try {
      resolveApiKey(cfg, { env: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingApiKeyError);
      const msg = (err as Error).message;
      expect(msg).toContain('groq');
      expect(msg).toContain('GROQ_API_KEY');
      expect(msg).toContain('.releasewise.local.json');
      expect(msg).toContain('--api-key');
    }
  });
});
