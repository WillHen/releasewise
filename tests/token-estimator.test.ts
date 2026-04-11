import { describe, expect, it } from 'bun:test';

import { estimateTokens } from '../src/utils/token-estimator.ts';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up for partial tokens', () => {
    // 1 char → ceil(1/4) = 1
    expect(estimateTokens('x')).toBe(1);
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('is exact on 4-char boundaries', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('scales linearly with string length', () => {
    const short = 'a'.repeat(100);
    const long = 'a'.repeat(400);
    expect(estimateTokens(short)).toBe(25);
    expect(estimateTokens(long)).toBe(100);
  });

  it('counts characters, not bytes — unicode is 1 char per code unit', () => {
    // 'café' = 4 code units → 1 token
    expect(estimateTokens('café')).toBe(1);
  });
});
