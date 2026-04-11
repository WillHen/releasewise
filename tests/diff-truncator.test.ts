import { describe, expect, it } from 'bun:test';

import { truncateDiff } from '../src/utils/diff-truncator.ts';
import { estimateTokens } from '../src/utils/token-estimator.ts';

// --------- Fixtures ---------

/**
 * Build a minimal but valid-looking unified-diff chunk for a single file.
 * `bodyLines` is how many `+` content lines to include — handy for
 * pumping up the estimated token count without writing real code.
 */
function fileChunk(path: string, bodyLines: number): string {
  const header =
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${bodyLines} @@`;
  const body = Array.from(
    { length: bodyLines },
    (_, i) => `+line ${i} of ${path} with some filler content`,
  ).join('\n');
  return `${header}\n${body}`;
}

function joinChunks(...chunks: string[]): string {
  return chunks.join('\n');
}

// --------- Contract ---------

describe('truncateDiff — contract', () => {
  it('throws on a non-positive budget', () => {
    expect(() => truncateDiff('anything', 0)).toThrow(/positive/);
    expect(() => truncateDiff('anything', -5)).toThrow(/positive/);
    expect(() => truncateDiff('anything', Number.NaN)).toThrow(/positive/);
  });

  it('returns empty input unchanged when under budget', () => {
    const result = truncateDiff('', 100);
    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.originalTokens).toBe(0);
    expect(result.finalTokens).toBe(0);
  });
});

// --------- Tier 0: fast path ---------

describe('truncateDiff — tier 0 fast path', () => {
  it('passes through a small diff unchanged', () => {
    const diff = fileChunk('src/a.ts', 3);
    const result = truncateDiff(diff, 10_000);
    expect(result.content).toBe(diff);
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.finalTokens).toBe(estimateTokens(diff));
  });

  it('handles a diff with no file boundaries by returning it as-is', () => {
    const junk = 'this is not a real diff '.repeat(200);
    const result = truncateDiff(junk, 10);
    expect(result.content).toBe(junk);
    // No file structure → nothing to drop, caller gets a note.
    expect(result.notes[0]).toMatch(/no file boundaries/);
  });
});

// --------- Tier 1: noisy files ---------

describe('truncateDiff — tier 1 noisy files', () => {
  it('drops package-lock.json before touching source files', () => {
    const sourceChunk = fileChunk('src/a.ts', 5);
    const lockChunk = fileChunk('package-lock.json', 800);
    const diff = joinChunks(sourceChunk, lockChunk);

    // Budget large enough for the source file but not the lockfile.
    const budget = estimateTokens(sourceChunk) + 20;
    const result = truncateDiff(diff, budget);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toContain('package-lock.json');
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('package-lock.json');
    expect(result.notes.some((n) => n.includes('package-lock.json'))).toBe(
      true,
    );
  });

  it('drops minified bundles and sourcemaps', () => {
    const src = fileChunk('src/a.ts', 5);
    const min = fileChunk('public/app.min.js', 500);
    const map = fileChunk('public/app.js.map', 500);
    const diff = joinChunks(src, min, map);

    const result = truncateDiff(diff, estimateTokens(src) + 20);

    expect(result.droppedFiles).toContain('public/app.min.js');
    expect(result.droppedFiles).toContain('public/app.js.map');
    expect(result.content).not.toContain('app.min.js');
    expect(result.content).not.toContain('app.js.map');
    expect(result.content).toContain('src/a.ts');
  });

  it('drops files under dist/ and build/ dirs', () => {
    const src = fileChunk('src/a.ts', 3);
    const dist = fileChunk('dist/bundle.js', 500);
    const build = fileChunk('build/output.css', 500);
    const diff = joinChunks(src, dist, build);

    const result = truncateDiff(diff, estimateTokens(src) + 20);

    expect(result.droppedFiles).toContain('dist/bundle.js');
    expect(result.droppedFiles).toContain('build/output.css');
    expect(result.content).toContain('src/a.ts');
  });

  it('does not drop a source file that happens to contain "dist" in its name', () => {
    const src = fileChunk('src/distance.ts', 3);
    // Force truncation pressure so tier 1 actually runs.
    const noise = fileChunk('yarn.lock', 800);
    const diff = joinChunks(src, noise);

    const result = truncateDiff(diff, estimateTokens(src) + 20);

    // The lockfile should be dropped but the distance file kept.
    expect(result.droppedFiles).toContain('yarn.lock');
    expect(result.droppedFiles).not.toContain('src/distance.ts');
    expect(result.content).toContain('src/distance.ts');
  });
});

// --------- Tier 2: drop largest bodies ---------

describe('truncateDiff — tier 2 stub largest bodies', () => {
  it('stubs the biggest file first, keeping smaller ones intact', () => {
    const small = fileChunk('src/small.ts', 3);
    const medium = fileChunk('src/medium.ts', 20);
    const huge = fileChunk('src/huge.ts', 500);
    const diff = joinChunks(small, medium, huge);

    // Generous enough for small+medium but not for huge.
    const budget = estimateTokens(small) + estimateTokens(medium) + 50;
    const result = truncateDiff(diff, budget);

    expect(result.truncated).toBe(true);
    // Huge was stubbed → its path is in droppedFiles and the content
    // contains an omission marker, not the body lines.
    expect(result.droppedFiles).toContain('src/huge.ts');
    expect(result.content).toContain('src/huge.ts');
    expect(result.content).toMatch(/lines omitted from src\/huge\.ts/);
    // Small and medium should still be fully present (their content
    // lines show up in the diff).
    expect(result.content).toContain('line 0 of src/small.ts');
    expect(result.content).toContain('line 0 of src/medium.ts');
    // And we should be under budget now.
    expect(result.finalTokens).toBeLessThanOrEqual(budget);
  });

  it('stops stubbing as soon as it fits under budget', () => {
    const a = fileChunk('src/a.ts', 200);
    const b = fileChunk('src/b.ts', 200);
    const c = fileChunk('src/c.ts', 200);
    const diff = joinChunks(a, b, c);

    // Enough room for two full files.
    const budget = estimateTokens(a) * 2 + 50;
    const result = truncateDiff(diff, budget);

    expect(result.truncated).toBe(true);
    // Exactly one file should have been stubbed.
    expect(result.droppedFiles.length).toBe(1);
    expect(result.finalTokens).toBeLessThanOrEqual(budget);
  });
});

// --------- Tier 3: drop whole files ---------

describe('truncateDiff — tier 3 drop whole files', () => {
  it('drops whole files and appends a footer when stubbing is not enough', () => {
    // Lots of tiny files — stubbing each still leaves overhead that busts
    // a very tight budget.
    const files = Array.from({ length: 30 }, (_, i) =>
      fileChunk(`src/tiny${i}.ts`, 3),
    );
    const diff = joinChunks(...files);

    // Tight budget: room for roughly two files worth of stubbed entries.
    const result = truncateDiff(diff, 40);

    expect(result.truncated).toBe(true);
    // Footer should list omitted files.
    expect(result.content).toMatch(/file\(s\) omitted to fit budget/);
    // Notes should mention dropping additional files.
    expect(result.notes.some((n) => /additional file/.test(n))).toBe(true);
  });
});
