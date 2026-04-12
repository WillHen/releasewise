import { describe, expect, it } from 'bun:test';

import {
  createGeminiProvider,
  type GeminiClient,
  type GeminiResponse,
} from '../src/core/ai/gemini.ts';

// --------- Fixtures ---------

function fakeClient(
  handler: (params: {
    model: string;
    contents: string;
    config?: {
      maxOutputTokens?: number;
      temperature?: number;
      systemInstruction?: string;
    };
  }) => Promise<GeminiResponse>,
): GeminiClient {
  return { generateContent: handler };
}

function geminiResponse(
  text: string,
  usage = { promptTokenCount: 10, candidatesTokenCount: 5 },
): GeminiResponse {
  return { text, usageMetadata: usage };
}

function httpError(status: number, message = 'http'): Error {
  const err = new Error(message);
  (err as unknown as { status: number }).status = status;
  return err;
}

const instantRetry = { baseDelayMs: 1, sleep: async (): Promise<void> => {} };

// --------- Metadata ---------

describe('createGeminiProvider — metadata', () => {
  it('exposes name = "gemini" and the configured model', () => {
    const provider = createGeminiProvider({
      client: fakeClient(async () => geminiResponse('ok')),
      model: 'gemini-2.0-flash',
    });
    expect(provider.name).toBe('gemini');
    expect(provider.defaultModel).toBe('gemini-2.0-flash');
  });

  it('exposes estimateTokens delegating to the chars/4 heuristic', () => {
    const provider = createGeminiProvider({
      client: fakeClient(async () => geminiResponse('x')),
      model: 'x',
    });
    expect(provider.estimateTokens('')).toBe(0);
    expect(provider.estimateTokens('abcd')).toBe(1);
  });
});

// --------- Request shape ---------

describe('createGeminiProvider — request shape', () => {
  it('forwards system, user, model, temperature, and maxTokens', async () => {
    let seenParams: unknown = null;
    const provider = createGeminiProvider({
      client: fakeClient(async (params) => {
        seenParams = params;
        return geminiResponse('reply', {
          promptTokenCount: 42,
          candidatesTokenCount: 7,
        });
      }),
      model: 'gemini-2.0-flash',
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

    const p = seenParams as {
      model: string;
      contents: string;
      config: {
        maxOutputTokens: number;
        temperature: number;
        systemInstruction: string;
      };
    };
    expect(p.model).toBe('gemini-2.0-flash');
    expect(p.contents).toBe('summarize these commits');
    expect(p.config.maxOutputTokens).toBe(256);
    expect(p.config.temperature).toBe(0.2);
    expect(p.config.systemInstruction).toBe('you write release notes');
  });

  it('omits systemInstruction when system is empty', async () => {
    let seenParams: unknown = null;
    const provider = createGeminiProvider({
      client: fakeClient(async (params) => {
        seenParams = params;
        return geminiResponse('hi');
      }),
      model: 'x',
    });

    await provider.generate({ system: '', user: 'hello' });

    const p = seenParams as { config: { systemInstruction?: string } };
    expect(p.config.systemInstruction).toBeUndefined();
  });

  it('applies defaults when maxTokens and temperature are omitted', async () => {
    let seenParams: unknown = null;
    const provider = createGeminiProvider({
      client: fakeClient(async (params) => {
        seenParams = params;
        return geminiResponse('hi');
      }),
      model: 'x',
    });

    await provider.generate({ system: 's', user: 'u' });

    const p = seenParams as {
      config: { maxOutputTokens: number; temperature: number };
    };
    expect(p.config.maxOutputTokens).toBeGreaterThan(0);
    expect(typeof p.config.temperature).toBe('number');
  });
});

// --------- Response parsing ---------

describe('createGeminiProvider — response parsing', () => {
  it('returns empty string when text is undefined', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(async () => ({
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
      })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('');
  });

  it('returns zero tokens when usageMetadata is missing', async () => {
    const provider = createGeminiProvider({
      client: fakeClient(async () => ({ text: 'hello' })),
      model: 'x',
    });
    const result = await provider.generate({ system: '', user: 'u' });
    expect(result.text).toBe('hello');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

// --------- Retry behavior ---------

describe('createGeminiProvider — retry behavior', () => {
  it('retries on HTTP 5xx and eventually succeeds', async () => {
    let calls = 0;
    const provider = createGeminiProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 2) throw httpError(500, 'server');
        return geminiResponse('recovered');
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
    const provider = createGeminiProvider({
      client: fakeClient(async () => {
        calls++;
        if (calls < 3) throw httpError(429, 'throttled');
        return geminiResponse('ok');
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
    const provider = createGeminiProvider({
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
});
