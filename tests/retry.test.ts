import { describe, expect, it } from 'bun:test';

import { withRetry } from '../src/utils/retry.ts';

// A no-op sleep used by tests so they run instantly. The real setTimeout
// path is only exercised implicitly via this wrapper's unit tests not
// asserting timing.
const noSleep = async (): Promise<void> => {};

describe('withRetry', () => {
  it('returns the value on the first attempt when fn succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries on failure until fn succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'ok';
      },
      {
        baseDelayMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    // 3 attempts → 2 sleeps with exponential growth (10, 20).
    expect(sleeps).toEqual([10, 20]);
  });

  it('throws the last error after exhausting all attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 3, baseDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow(/fail 3/);
    expect(calls).toBe(3);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        {
          attempts: 5,
          baseDelayMs: 1,
          sleep: noSleep,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow(/fatal/);
    expect(calls).toBe(1);
  });

  it('passes the failing attempt number to shouldRetry', async () => {
    const seen: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new Error('nope');
        },
        {
          attempts: 4,
          baseDelayMs: 1,
          sleep: noSleep,
          shouldRetry: (_err, n) => {
            seen.push(n);
            return n < 2;
          },
        },
      ),
    ).rejects.toThrow();
    // Called on failures 1 and 2; after 2 returns false, the loop stops.
    expect(seen).toEqual([1, 2]);
  });

  it('throws a clear error when attempts < 1', async () => {
    await expect(withRetry(async () => 1, { attempts: 0 })).rejects.toThrow(
      /attempts/,
    );
  });

  it('accepts a custom growth factor', async () => {
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new Error('x');
        },
        {
          attempts: 4,
          baseDelayMs: 10,
          factor: 3,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow();
    // 4 attempts → 3 sleeps: 10, 30, 90.
    expect(sleeps).toEqual([10, 30, 90]);
  });
});
