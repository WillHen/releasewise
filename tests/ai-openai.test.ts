import { describe, expect, it } from 'bun:test';

import {
  createOpenAIProvider,
  type OpenAIClient,
  type OpenAIChatCompletion,
  type OpenAIChatParams,
} from '../src/core/ai/openai.ts';

// --------- Fixtures ---------

function fakeClient(
  handler: (params: OpenAIChatParams) => Promise<OpenAIChatCompletion>,
): OpenAIClient {
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
): OpenAIChatCompletion {
  return {
    choices: [{ message: { content: text } }],
    usage,
  };
}

function httpError(status: number, message = 'http'): Error {
  const err = new Error(message);
  (err as unknown as { status: number }).status = status;
  return err;
}

const instantRetry = { baseDelayMs: 1, sleep: async (): Promise<void> => {} };

// --------- Metadata ---------

describe('createOpenAIProvider — metadata', () => {
  it('exposes name = "openai" and the configured model', () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => chatCompletion('ok')),
      model: 'gpt-4o',
    });
    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBe('gpt-4o');
  });

  it('uses custom providerName when specified', () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => chatCompletion('ok')),
      model: 'llama-3.3-70b-versatile',
      providerName: 'groq',
    });
    expect(provider.name).toBe('groq');
  });

  it('exposes estimateTokens delegating to the chars/4 heuristic', () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => chatCompletion('x')),
      model: 'x',
    });
    expect(provider.estimateTokens('')).toBe(0);
    expect(provider.estimateTokens('abcd')).toBe(1);
  });
});

// --------- Request shape ---------

describe('createOpenAIProvider — request shape', () => {
  it('forwards system as a system message and user as a user message', async () => {
    let seen: OpenAIChatParams | null = null;
    const provider = createOpenAIProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return chatCompletion('reply', {
          prompt_tokens: 42,
          completion_tokens: 7,
        });
      }),
      model: 'gpt-4o-mini',
    });

    const result = await provider.generate({
      system: 'you write release notes',
      user: 'summarize these commits',
      maxTokens: 256,
      temperature: 0.2,
    });

    expect(result.text).toBe('reply');
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(7);

    expect(seen).not.toBeNull();
    const p = seen as unknown as OpenAIChatParams;
    expect(p.model).toBe('gpt-4o-mini');
    expect(p.max_tokens).toBe(256);
    expect(p.temperature).toBe(0.2);
    expect(p.messages).toEqual([
      { role: 'system', content: 'you write release notes' },
      { role: 'user', content: 'summarize these commits' },
    ]);
  });

  it('omits system message when system is empty', async () => {
    let seen: OpenAIChatParams | null = null;
    const provider = createOpenAIProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return chatCompletion('hi');
      }),
      model: 'gpt-4o',
    });

    await provider.generate({ system: '', user: 'hello' });

    const p = seen as unknown as OpenAIChatParams;
    expect(p.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('applies defaults when maxTokens and temperature are omitted', async () => {
    let seen: OpenAIChatParams | null = null;
    const provider = createOpenAIProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return chatCompletion('hi');
      }),
      model: 'gpt-4o',
    });

    await provider.generate({ system: 's', user: 'u' });

    const p = seen as unknown as OpenAIChatParams;
    expect(p.max_tokens).toBeGreaterThan(0);
    expect(typeof p.temperature).toBe('number');
  });
});

// --------- Response parsing ---------

describe('createOpenAIProvider — response parsing', () => {
  it('returns empty string when content is null', async () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => ({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('');
  });

  it('returns empty string when choices is empty', async () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => ({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('');
  });

  it('returns zero tokens when usage is missing', async () => {
    const provider = createOpenAIProvider({
      client: fakeClient(async () => ({
        choices: [{ message: { content: 'text' } }],
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('text');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

// --------- Retry behavior ---------

describe('createOpenAIProvider — retry behavior', () => {
  it('retries on HTTP 5xx and eventually succeeds', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 2) throw httpError(500, 'server');
        return chatCompletion('recovered');
      }),
      model: 'x',
      retry: instantRetry,
    });

    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('retries on HTTP 429 rate-limit', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 3) throw httpError(429, 'throttled');
        return chatCompletion('ok');
      }),
      model: 'x',
      retry: instantRetry,
    });

    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry on HTTP 400', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      client: fakeClient(async () => {
        calls++;
        throw httpError(400, 'bad request');
      }),
      model: 'x',
      retry: { ...instantRetry, attempts: 5 },
    });

    await expect(provider.generate({ system: '', user: 'u' })).rejects.toThrow(
      /bad request/,
    );
    expect(calls).toBe(1);
  });

  it('does not retry on HTTP 401', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      client: fakeClient(async () => {
        calls++;
        throw httpError(401, 'unauthorized');
      }),
      model: 'x',
      retry: { ...instantRetry, attempts: 5 },
    });

    await expect(provider.generate({ system: '', user: 'u' })).rejects.toThrow(
      /unauthorized/,
    );
    expect(calls).toBe(1);
  });
});
