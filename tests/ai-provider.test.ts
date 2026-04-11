import { describe, expect, it } from 'bun:test';

import type { AnthropicClient } from '../src/core/ai/anthropic.ts';
import { getProvider } from '../src/core/ai/provider.ts';
import { defaultConfig, type Config } from '../src/core/config.ts';

// --------- Fixtures ---------

function configWith(aiOverrides: Partial<Config['ai']>): Config {
  const c = defaultConfig();
  return { ...c, ai: { ...c.ai, ...aiOverrides } };
}

const stubAnthropicClient: AnthropicClient = {
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: 'stub' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
};

// --------- Tests ---------

describe('getProvider', () => {
  it('builds an Anthropic adapter when config.ai.provider = anthropic', () => {
    const config = configWith({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    const provider = getProvider({
      config,
      apiKey: 'sk-test',
      anthropicClient: stubAnthropicClient,
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.defaultModel).toBe('claude-haiku-4-5');
  });

  it('uses the injected Anthropic client end-to-end', async () => {
    let calls = 0;
    const client: AnthropicClient = {
      messages: {
        create: async () => {
          calls++;
          return {
            content: [{ type: 'text', text: 'from fake' }],
            usage: { input_tokens: 3, output_tokens: 4 },
          };
        },
      },
    };
    const provider = getProvider({
      config: configWith({ provider: 'anthropic' }),
      apiKey: 'sk-test',
      anthropicClient: client,
    });
    const result = await provider.generate({ system: 's', user: 'u' });
    expect(calls).toBe(1);
    expect(result.text).toBe('from fake');
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(4);
  });

  it('throws a clear not-yet-implemented error for openai', () => {
    const config = configWith({ provider: 'openai' });
    expect(() => getProvider({ config, apiKey: 'sk-test' })).toThrow(
      /not yet implemented/i,
    );
  });

  it('throws a clear not-yet-implemented error for groq', () => {
    const config = configWith({ provider: 'groq' });
    expect(() => getProvider({ config, apiKey: 'sk-test' })).toThrow(
      /not yet implemented/i,
    );
  });

  it('throws a clear not-yet-implemented error for gemini', () => {
    const config = configWith({ provider: 'gemini' });
    expect(() => getProvider({ config, apiKey: 'sk-test' })).toThrow(
      /not yet implemented/i,
    );
  });

  it('mentions Step 10 in the not-yet-implemented error so users know when it is coming', () => {
    const config = configWith({ provider: 'openai' });
    expect(() => getProvider({ config, apiKey: 'sk-test' })).toThrow(
      /step 10/i,
    );
  });
});
