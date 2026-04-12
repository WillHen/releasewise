import { describe, expect, it } from 'bun:test';

import type { AnthropicClient } from '../src/core/ai/anthropic.ts';
import type { GeminiClient } from '../src/core/ai/gemini.ts';
import type { OpenAIClient } from '../src/core/ai/openai.ts';
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

const stubOpenAIClient: OpenAIClient = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{ message: { content: 'openai stub' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    },
  },
};

const stubGeminiClient: GeminiClient = {
  generateContent: async () => ({
    text: 'gemini stub',
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }),
};

// --------- Tests ---------

describe('getProvider', () => {
  // Anthropic
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

  // OpenAI
  it('builds an OpenAI adapter when config.ai.provider = openai', () => {
    const config = configWith({ provider: 'openai', model: 'gpt-4o' });
    const provider = getProvider({
      config,
      apiKey: 'sk-test',
      openaiClient: stubOpenAIClient,
    });
    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBe('gpt-4o');
  });

  it('uses the injected OpenAI client end-to-end', async () => {
    let calls = 0;
    const client: OpenAIClient = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            return {
              choices: [{ message: { content: 'from openai fake' } }],
              usage: { prompt_tokens: 5, completion_tokens: 6 },
            };
          },
        },
      },
    };
    const provider = getProvider({
      config: configWith({ provider: 'openai' }),
      apiKey: 'sk-test',
      openaiClient: client,
    });
    const result = await provider.generate({ system: 's', user: 'u' });
    expect(calls).toBe(1);
    expect(result.text).toBe('from openai fake');
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(6);
  });

  // Groq
  it('builds a Groq adapter (name = "groq") using the OpenAI client', () => {
    const config = configWith({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
    const provider = getProvider({
      config,
      apiKey: 'gsk-test',
      openaiClient: stubOpenAIClient,
    });
    expect(provider.name).toBe('groq');
    expect(provider.defaultModel).toBe('llama-3.3-70b-versatile');
  });

  it('uses the injected OpenAI client for Groq end-to-end', async () => {
    let calls = 0;
    const client: OpenAIClient = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            return {
              choices: [{ message: { content: 'from groq fake' } }],
              usage: { prompt_tokens: 2, completion_tokens: 3 },
            };
          },
        },
      },
    };
    const provider = getProvider({
      config: configWith({ provider: 'groq' }),
      apiKey: 'gsk-test',
      openaiClient: client,
    });
    const result = await provider.generate({ system: 's', user: 'u' });
    expect(calls).toBe(1);
    expect(result.text).toBe('from groq fake');
  });

  // Gemini
  it('builds a Gemini adapter when config.ai.provider = gemini', () => {
    const config = configWith({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    });
    const provider = getProvider({
      config,
      apiKey: 'test-key',
      geminiClient: stubGeminiClient,
    });
    expect(provider.name).toBe('gemini');
    expect(provider.defaultModel).toBe('gemini-2.0-flash');
  });

  it('uses the injected Gemini client end-to-end', async () => {
    let calls = 0;
    const client: GeminiClient = {
      generateContent: async () => {
        calls++;
        return {
          text: 'from gemini fake',
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 9 },
        };
      },
    };
    const provider = getProvider({
      config: configWith({ provider: 'gemini' }),
      apiKey: 'test-key',
      geminiClient: client,
    });
    const result = await provider.generate({ system: 's', user: 'u' });
    expect(calls).toBe(1);
    expect(result.text).toBe('from gemini fake');
    expect(result.inputTokens).toBe(8);
    expect(result.outputTokens).toBe(9);
  });
});
