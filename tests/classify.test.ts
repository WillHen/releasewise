import { describe, expect, it } from 'bun:test';

import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
  classifyCommits,
  parseClassifierResponse,
} from '../src/core/classify.ts';
import type { AIProvider, Commit } from '../src/types.ts';

// --------- Fixtures ---------

function commit(partial: Partial<Commit>): Commit {
  return {
    sha: 'f'.repeat(40),
    shortSha: 'abc1234',
    author: 'Test',
    authorEmail: 'test@example.com',
    date: '2026-04-11T12:00:00Z',
    subject: '',
    body: '',
    ...partial,
  };
}

function fakeProvider(respond: (user: string) => string): AIProvider {
  return {
    name: 'anthropic',
    defaultModel: 'fake',
    estimateTokens: (s) => s.length,
    async generate(req) {
      return {
        text: respond(req.user),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

function throwingProvider(message: string): AIProvider {
  return {
    name: 'anthropic',
    defaultModel: 'fake',
    estimateTokens: () => 0,
    async generate() {
      throw new Error(message);
    },
  };
}

// --------- CLASSIFIER_SYSTEM_PROMPT ---------

describe('CLASSIFIER_SYSTEM_PROMPT', () => {
  it('is non-empty and names all four bump levels', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('major');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('minor');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('patch');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('skip');
  });

  it('requires strict JSON array output', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toContain('json array');
  });
});

// --------- buildClassifierUserPrompt ---------

describe('buildClassifierUserPrompt', () => {
  it('lists commits with short SHAs and subjects', () => {
    const prompt = buildClassifierUserPrompt([
      commit({ shortSha: 'aa1', subject: 'random thing' }),
      commit({ shortSha: 'bb2', subject: 'another thing' }),
    ]);
    expect(prompt).toContain('- aa1: random thing');
    expect(prompt).toContain('- bb2: another thing');
  });

  it('includes the total count', () => {
    const prompt = buildClassifierUserPrompt([
      commit({ shortSha: 'aa1', subject: 'x' }),
    ]);
    expect(prompt).toContain('1 commit');
  });

  it('indents body lines under the subject', () => {
    const prompt = buildClassifierUserPrompt([
      commit({ shortSha: 'aa1', subject: 'x', body: 'line 1\nline 2' }),
    ]);
    expect(prompt).toContain('    line 1');
    expect(prompt).toContain('    line 2');
  });
});

// --------- parseClassifierResponse ---------

describe('parseClassifierResponse', () => {
  it('parses a bare JSON array', () => {
    const entries = parseClassifierResponse(
      '[{"sha":"aa1","bump":"minor","rationale":"new feature"}]',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      sha: 'aa1',
      bump: 'minor',
      rationale: 'new feature',
    });
  });

  it('parses an array wrapped in a ``` fence', () => {
    const entries = parseClassifierResponse(
      '```\n[{"sha":"aa1","bump":"patch","rationale":"fix"}]\n```',
    );
    expect(entries[0]!.sha).toBe('aa1');
  });

  it('parses an array wrapped in a ```json fence', () => {
    const entries = parseClassifierResponse(
      '```json\n[{"sha":"aa1","bump":"patch","rationale":"fix"}]\n```',
    );
    expect(entries[0]!.bump).toBe('patch');
  });

  it('extracts an array embedded in prose', () => {
    const entries = parseClassifierResponse(
      'Sure, here is the classification: [{"sha":"aa1","bump":"major","rationale":"breaks api"}] done.',
    );
    expect(entries[0]!.bump).toBe('major');
  });

  it('handles the skip level', () => {
    const entries = parseClassifierResponse(
      '[{"sha":"aa1","bump":"skip","rationale":"internal only"}]',
    );
    expect(entries[0]!.bump).toBe('skip');
  });

  it('tolerates a missing rationale by defaulting to empty string', () => {
    const entries = parseClassifierResponse('[{"sha":"aa1","bump":"patch"}]');
    expect(entries[0]!.rationale).toBe('');
  });

  it('throws on empty/non-array input', () => {
    expect(() => parseClassifierResponse('')).toThrow();
    expect(() => parseClassifierResponse('not json')).toThrow();
    expect(() => parseClassifierResponse('{"sha":"aa1"}')).toThrow();
  });

  it('throws on invalid bump value', () => {
    expect(() =>
      parseClassifierResponse('[{"sha":"aa1","bump":"huge"}]'),
    ).toThrow();
  });

  it('throws on missing sha', () => {
    expect(() => parseClassifierResponse('[{"bump":"patch"}]')).toThrow();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseClassifierResponse('[{"sha":"aa1"')).toThrow();
  });
});

// --------- classifyCommits: conventional mode ---------

describe('classifyCommits — conventional mode', () => {
  it('classifies each commit via the conventional parser', async () => {
    const result = await classifyCommits({
      mode: 'conventional',
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: add thing' }),
        commit({ shortSha: 'bb', subject: 'fix: handle edge' }),
      ],
    });
    expect(result.commits[0]!.bump).toBe('minor');
    expect(result.commits[0]!.source).toBe('conventional');
    expect(result.commits[1]!.bump).toBe('patch');
  });

  it('aggregates to the max bump', async () => {
    const result = await classifyCommits({
      mode: 'conventional',
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'bb', subject: 'fix: y' }),
      ],
    });
    expect(result.bump).toBe('minor');
  });

  it('returns none for an empty commit list', async () => {
    const result = await classifyCommits({
      mode: 'conventional',
      commits: [],
    });
    expect(result.bump).toBe('none');
    expect(result.commits).toEqual([]);
  });

  it('detects breaking changes', async () => {
    const result = await classifyCommits({
      mode: 'conventional',
      commits: [
        commit({ shortSha: 'aa', subject: 'feat(api)!: drop old route' }),
        commit({ shortSha: 'bb', subject: 'fix: thing' }),
      ],
    });
    expect(result.bump).toBe('major');
  });

  it('leaves unknown commits at none and does not call the provider', async () => {
    let called = false;
    const provider = fakeProvider(() => {
      called = true;
      return '[]';
    });
    const result = await classifyCommits({
      mode: 'conventional',
      provider,
      commits: [commit({ shortSha: 'aa', subject: 'random thing' })],
    });
    expect(called).toBe(false);
    expect(result.commits[0]!.bump).toBe('none');
    expect(result.bump).toBe('none');
  });
});

// --------- classifyCommits: mixed mode ---------

describe('classifyCommits — mixed mode', () => {
  it('skips the AI when every commit is already classified', async () => {
    let called = false;
    const provider = fakeProvider(() => {
      called = true;
      return '[]';
    });
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'bb', subject: 'fix: y' }),
      ],
    });
    expect(called).toBe(false);
    expect(result.bump).toBe('minor');
  });

  it('sends only unknown commits to the AI', async () => {
    let seenUser = '';
    const provider = fakeProvider((user) => {
      seenUser = user;
      return '[{"sha":"zz","bump":"patch","rationale":"fallback"}]';
    });
    await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'zz', subject: 'random thing' }),
      ],
    });
    expect(seenUser).toContain('zz: random thing');
    expect(seenUser).not.toContain('aa: feat: x');
  });

  it('merges AI classification back onto unknown commits', async () => {
    const provider = fakeProvider(() =>
      JSON.stringify([
        { sha: 'zz', bump: 'minor', rationale: 'new user-facing behavior' },
      ]),
    );
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'zz', subject: 'random new behavior' }),
      ],
    });
    expect(result.commits[0]!.bump).toBe('minor');
    expect(result.commits[0]!.source).toBe('conventional');
    expect(result.commits[1]!.bump).toBe('minor');
    expect(result.commits[1]!.source).toBe('ai');
    expect(result.commits[1]!.rationale).toBe('new user-facing behavior');
    expect(result.bump).toBe('minor');
  });

  it('treats AI "skip" as no contribution to the bump', async () => {
    const provider = fakeProvider(() =>
      JSON.stringify([{ sha: 'zz', bump: 'skip', rationale: 'internal' }]),
    );
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [commit({ shortSha: 'zz', subject: 'internal cleanup' })],
    });
    expect(result.commits[0]!.bump).toBe('none');
    expect(result.commits[0]!.source).toBe('ai');
    expect(result.bump).toBe('none');
  });

  it('AI major overrides a conventional minor', async () => {
    const provider = fakeProvider(() =>
      JSON.stringify([
        { sha: 'zz', bump: 'major', rationale: 'breaks things' },
      ]),
    );
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'zz', subject: 'rip out the old api' }),
      ],
    });
    expect(result.bump).toBe('major');
  });

  it('degrades to conventional when provider is null', async () => {
    const result = await classifyCommits({
      mode: 'mixed',
      provider: null,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'zz', subject: 'random thing' }),
      ],
    });
    expect(result.commits[1]!.bump).toBe('none');
    expect(result.commits[1]!.source).toBe('conventional');
    expect(result.bump).toBe('minor');
  });

  it('falls back to patch when the provider throws', async () => {
    const provider = throwingProvider('rate limit exhausted');
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [commit({ shortSha: 'zz', subject: 'random thing' })],
    });
    expect(result.commits[0]!.bump).toBe('patch');
    expect(result.commits[0]!.source).toBe('ai');
    expect(result.commits[0]!.rationale).toContain('rate limit');
  });

  it('falls back to patch when the response is unparseable', async () => {
    const provider = fakeProvider(() => 'not json at all');
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [commit({ shortSha: 'zz', subject: 'random thing' })],
    });
    expect(result.commits[0]!.bump).toBe('patch');
    expect(result.commits[0]!.rationale!.toLowerCase()).toContain('fail');
  });

  it('falls back to patch for unknowns the AI omitted from its response', async () => {
    const provider = fakeProvider(() =>
      JSON.stringify([{ sha: 'zz', bump: 'minor', rationale: 'new behavior' }]),
    );
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'zz', subject: 'thing one' }),
        commit({ shortSha: 'yy', subject: 'thing two' }),
      ],
    });
    expect(result.commits[0]!.bump).toBe('minor');
    expect(result.commits[1]!.bump).toBe('patch');
    expect(result.commits[1]!.rationale).toContain('did not return');
  });

  it('passes maxOutputTokens and temperature through to the provider', async () => {
    let seenMax: number | undefined;
    let seenTemp: number | undefined;
    const provider: AIProvider = {
      name: 'anthropic',
      defaultModel: 'fake',
      estimateTokens: () => 0,
      async generate(req) {
        seenMax = req.maxTokens;
        seenTemp = req.temperature;
        return {
          text: '[{"sha":"zz","bump":"patch","rationale":"x"}]',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [commit({ shortSha: 'zz', subject: 'random' })],
      maxOutputTokens: 512,
      temperature: 0.1,
    });
    expect(seenMax).toBe(512);
    expect(seenTemp).toBe(0.1);
  });

  it('preserves input order in the output', async () => {
    const provider = fakeProvider(() =>
      JSON.stringify([
        { sha: 'zz', bump: 'patch', rationale: 'x' },
        { sha: 'yy', bump: 'patch', rationale: 'y' },
      ]),
    );
    const result = await classifyCommits({
      mode: 'mixed',
      provider,
      commits: [
        commit({ shortSha: 'aa', subject: 'feat: x' }),
        commit({ shortSha: 'zz', subject: 'unknown 1' }),
        commit({ shortSha: 'bb', subject: 'fix: y' }),
        commit({ shortSha: 'yy', subject: 'unknown 2' }),
      ],
    });
    expect(result.commits.map((c) => c.shortSha)).toEqual([
      'aa',
      'zz',
      'bb',
      'yy',
    ]);
  });
});
