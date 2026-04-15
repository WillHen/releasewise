/**
 * Groq adapter tests.
 *
 * Groq is an OpenAI-compatible provider, so the adapter in `groq.ts` is a
 * thin re-export of `createOpenAIProvider`. These tests cover the surface
 * that *is* Groq-specific and not already covered by `ai-openai.test.ts`:
 *
 *   1. The re-exported factory builds a provider labeled `groq`.
 *   2. `getProvider` wires Groq to the OpenAI SDK via the injected client
 *      (base URL defaulting is trusted to the OpenAI SDK itself — see
 *      provider.ts for the constant).
 *   3. A happy-path `generate` call flows through the OpenAI-compat
 *      chat.completions endpoint and returns text + token usage.
 */
import { describe, expect, it } from 'bun:test';

import {
  createGroqProvider,
  type GroqChatCompletion,
  type GroqChatParams,
  type GroqClient,
} from '../src/core/ai/groq.ts';
import { getProvider } from '../src/core/ai/provider.ts';
import { defaultConfig, type Config } from '../src/core/config.ts';

// --------- Fixtures ---------

function fakeClient(
  handler: (params: GroqChatParams) => Promise<GroqChatCompletion>,
): GroqClient {
  return {
    chat: {
      completions: {
        create: handler,
      },
    },
  };
}

function chatCompletion(
  text: string,
  usage = { prompt_tokens: 10, completion_tokens: 5 },
): GroqChatCompletion {
  return {
    choices: [{ message: { content: text } }],
    usage,
  };
}

function configWith(aiOverrides: Partial<Config['ai']>): Config {
  const c = defaultConfig();
  return { ...c, ai: { ...c.ai, ...aiOverrides } };
}

// --------- Factory re-export ---------

describe('createGroqProvider — re-exports the OpenAI adapter', () => {
  it('builds a provider labeled "groq" when providerName is set', () => {
    const provider = createGroqProvider({
      client: fakeClient(async () => chatCompletion('ok')),
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
    });
    expect(provider.name).toBe('groq');
    expect(provider.defaultModel).toBe('llama-3.3-70b-versatile');
  });
});

// --------- Happy-path generate call ---------

describe('createGroqProvider — generate() hits OpenAI-compat endpoint', () => {
  it('sends system + user messages and returns text + token usage', async () => {
    let seen: GroqChatParams | null = null;
    const provider = createGroqProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return chatCompletion('release notes from groq', {
          prompt_tokens: 123,
          completion_tokens: 45,
        });
      }),
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
    });

    const result = await provider.generate({
      system: 'you write release notes',
      user: 'summarize commits',
      maxTokens: 512,
      temperature: 0.2,
    });

    expect(result.text).toBe('release notes from groq');
    expect(result.inputTokens).toBe(123);
    expect(result.outputTokens).toBe(45);

    // Confirm the call really went through the chat.completions shape —
    // this is the OpenAI-compat contract Groq implements.
    const params = seen as unknown as GroqChatParams;
    expect(params).not.toBeNull();
    expect(params.model).toBe('llama-3.3-70b-versatile');
    expect(params.max_tokens).toBe(512);
    expect(params.temperature).toBe(0.2);
    expect(params.messages).toEqual([
      { role: 'system', content: 'you write release notes' },
      { role: 'user', content: 'summarize commits' },
    ]);
  });

  it('wires the injected client through getProvider end-to-end', async () => {
    let calls = 0;
    const client: GroqClient = {
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
    expect(provider.name).toBe('groq');
    expect(result.text).toBe('from groq fake');
  });

  it('surfaces a fatal OpenAI-compat error (e.g. 401 bad API key)', async () => {
    const provider = createGroqProvider({
      client: fakeClient(async () => {
        const err = new Error('unauthorized') as Error & { status: number };
        err.status = 401;
        throw err;
      }),
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
      retry: {
        baseDelayMs: 1,
        sleep: async (): Promise<void> => {},
        attempts: 3,
      },
    });

    await expect(provider.generate({ system: '', user: 'u' })).rejects.toThrow(
      /unauthorized/,
    );
  });
});
