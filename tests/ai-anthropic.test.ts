import { describe, expect, it } from 'bun:test';

import {
  createAnthropicProvider,
  type AnthropicClient,
  type AnthropicMessage,
  type AnthropicMessageParams,
} from '../src/core/ai/anthropic.ts';

// --------- Fixtures ---------

function fakeClient(
  handler: (params: AnthropicMessageParams) => Promise<AnthropicMessage>,
): AnthropicClient {
  return {
    messages: {
      create: handler,
    },
  };
}

function textMessage(
  text: string,
  usage = { input_tokens: 10, output_tokens: 5 },
): AnthropicMessage {
  return {
    content: [{ type: 'text', text }],
    usage,
  };
}

function httpError(status: number, message = 'http'): Error {
  const err = new Error(message);
  (err as unknown as { status: number }).status = status;
  return err;
}

// Retry options that make tests instant. Tests that need to assert
// retry count pass `attempts: N` on top of this.
const instantRetry = { baseDelayMs: 1, sleep: async (): Promise<void> => {} };

// --------- Metadata ---------

describe('createAnthropicProvider — metadata', () => {
  it('exposes name = "anthropic" and the configured model', () => {
    const provider = createAnthropicProvider({
      client: fakeClient(async () => textMessage('ok')),
      model: 'claude-opus-4-6',
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.defaultModel).toBe('claude-opus-4-6');
  });

  it('exposes estimateTokens delegating to the chars/4 heuristic', () => {
    const provider = createAnthropicProvider({
      client: fakeClient(async () => textMessage('x')),
      model: 'x',
    });
    expect(provider.estimateTokens('')).toBe(0);
    expect(provider.estimateTokens('abcd')).toBe(1);
    expect(provider.estimateTokens('hello')).toBe(2);
  });
});

// --------- Request shape ---------

describe('createAnthropicProvider — request shape', () => {
  it('forwards system, user, model, temperature, and maxTokens', async () => {
    let seen: AnthropicMessageParams | null = null;
    const provider = createAnthropicProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return textMessage('reply', { input_tokens: 42, output_tokens: 7 });
      }),
      model: 'claude-haiku-4-5',
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
    const p = seen as unknown as AnthropicMessageParams;
    expect(p.model).toBe('claude-haiku-4-5');
    expect(p.max_tokens).toBe(256);
    expect(p.temperature).toBe(0.2);
    expect(p.system).toBe('you write release notes');
    expect(p.messages).toEqual([
      { role: 'user', content: 'summarize these commits' },
    ]);
  });

  it('applies defaults when maxTokens and temperature are omitted', async () => {
    let seen: AnthropicMessageParams | null = null;
    const provider = createAnthropicProvider({
      client: fakeClient(async (params) => {
        seen = params;
        return textMessage('hi');
      }),
      model: 'claude-haiku-4-5',
    });

    await provider.generate({ system: 's', user: 'u' });

    const p = seen as unknown as AnthropicMessageParams;
    expect(p.max_tokens).toBeGreaterThan(0);
    expect(typeof p.temperature).toBe('number');
  });
});

// --------- Response parsing ---------

describe('createAnthropicProvider — response parsing', () => {
  it('concatenates multiple text content blocks', async () => {
    const provider = createAnthropicProvider({
      client: fakeClient(async () => ({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('part one part two');
  });

  it('ignores non-text content blocks', async () => {
    const provider = createAnthropicProvider({
      client: fakeClient(async () => ({
        content: [{ type: 'tool_use' }, { type: 'text', text: 'actual text' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('actual text');
  });

  it('returns an empty string when no text blocks are present', async () => {
    const provider = createAnthropicProvider({
      client: fakeClient(async () => ({
        content: [{ type: 'tool_use' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('');
  });
});

// --------- Retry behavior ---------

describe('createAnthropicProvider — retry behavior', () => {
  it('retries on HTTP 5xx and eventually succeeds', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 2) throw httpError(500, 'server');
        return textMessage('recovered');
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
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 3) throw httpError(429, 'throttled');
        return textMessage('ok');
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
    const provider = createAnthropicProvider({
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
    const provider = createAnthropicProvider({
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

  it('retries on generic errors without a status field', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 2) throw new Error('connection reset');
        return textMessage('ok');
      }),
      model: 'x',
      retry: instantRetry,
    });

    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls++;
        throw httpError(500, `attempt ${calls}`);
      }),
      model: 'x',
      retry: { ...instantRetry, attempts: 3 },
    });

    await expect(provider.generate({ system: '', user: 'u' })).rejects.toThrow(
      /attempt 3/,
    );
    expect(calls).toBe(3);
  });
});
