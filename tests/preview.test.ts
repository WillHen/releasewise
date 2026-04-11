import { describe, expect, it } from 'bun:test';

import type { ReleasePlan } from '../src/core/orchestrator.ts';
import type { ClassifiedCommit, RemoteInfo } from '../src/types.ts';
import { formatHumanPreview, formatJsonPreview } from '../src/utils/preview.ts';

// --------- Fixtures ---------

const github: RemoteInfo = {
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
};

function classified(partial: Partial<ClassifiedCommit>): ClassifiedCommit {
  return {
    sha: 'f'.repeat(40),
    shortSha: 'abc1234',
    subject: 'feat: add thing',
    body: '',
    author: 'Test',
    authorEmail: 'test@example.com',
    date: '2026-04-11T12:00:00Z',
    bump: 'minor',
    source: 'conventional',
    ...partial,
  };
}

function plan(partial: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    baseRef: 'v1.2.2',
    headSha: 'deadbeef',
    firstRelease: false,
    currentVersion: '1.2.2',
    previousVersion: '1.2.2',
    nextVersion: '1.3.0',
    bump: 'minor',
    bumpForced: false,
    commits: [classified({ shortSha: 'aa1', subject: 'feat: add login' })],
    truncatedDiff: {
      content: 'diff --git a/x b/x\n+foo',
      originalTokens: 100,
      finalTokens: 100,
      truncated: false,
      droppedFiles: [],
      notes: [],
    },
    remote: github,
    notes: {
      title: 'v1.3.0',
      heading: '## [1.3.0] - 2026-04-11',
      body: '### Added\n- Add login (aa1)',
    },
    changelogPath: '/abs/path/CHANGELOG.md',
    changelogBefore: '',
    changelogAfter:
      '# Changelog\n\n## [1.3.0] - 2026-04-11\n\n### Added\n- Add login (aa1)\n',
    date: '2026-04-11',
    warnings: [],
    ...partial,
  };
}

// --------- formatJsonPreview ---------

describe('formatJsonPreview', () => {
  it('has dryRun: true', () => {
    const out = formatJsonPreview(plan());
    expect(out.dryRun).toBe(true);
  });

  it('carries top-level fields from the plan', () => {
    const out = formatJsonPreview(
      plan({
        baseRef: 'v1.0.0',
        headSha: 'beef',
        firstRelease: true,
        currentVersion: '1.0.0',
        previousVersion: null,
        nextVersion: '1.1.0',
        bump: 'minor',
        bumpForced: false,
        date: '2026-04-11',
      }),
    );
    expect(out.baseRef).toBe('v1.0.0');
    expect(out.headSha).toBe('beef');
    expect(out.firstRelease).toBe(true);
    expect(out.previousVersion).toBeNull();
    expect(out.currentVersion).toBe('1.0.0');
    expect(out.nextVersion).toBe('1.1.0');
    expect(out.bump).toBe('minor');
    expect(out.bumpForced).toBe(false);
    expect(out.date).toBe('2026-04-11');
  });

  it('includes the commit count and narrowed commit entries', () => {
    const out = formatJsonPreview(
      plan({
        commits: [
          classified({
            shortSha: 'aa',
            subject: 'feat: x',
            bump: 'minor',
            source: 'conventional',
          }),
          classified({
            shortSha: 'bb',
            subject: 'random thing',
            bump: 'patch',
            source: 'ai',
            rationale: 'small internal change',
          }),
        ],
      }),
    );
    expect(out.commitCount).toBe(2);
    expect(out.commits).toHaveLength(2);
    expect(out.commits[0]).toEqual({
      shortSha: 'aa',
      subject: 'feat: x',
      bump: 'minor',
      source: 'conventional',
    });
    expect(out.commits[1]).toEqual({
      shortSha: 'bb',
      subject: 'random thing',
      bump: 'patch',
      source: 'ai',
      rationale: 'small internal change',
    });
  });

  it('omits rationale when not set', () => {
    const out = formatJsonPreview(
      plan({
        commits: [classified({ shortSha: 'aa' })],
      }),
    );
    expect(out.commits[0]!.rationale).toBeUndefined();
    // Ensure the key is actually missing (not just undefined).
    expect(
      Object.prototype.hasOwnProperty.call(out.commits[0]!, 'rationale'),
    ).toBe(false);
  });

  it('carries diff metadata without the body', () => {
    const out = formatJsonPreview(
      plan({
        truncatedDiff: {
          content: 'diff body not included in JSON',
          originalTokens: 5000,
          finalTokens: 1000,
          truncated: true,
          droppedFiles: ['package-lock.json'],
          notes: ['dropped package-lock.json'],
        },
      }),
    );
    expect(out.diff).toEqual({
      originalTokens: 5000,
      finalTokens: 1000,
      truncated: true,
      droppedFiles: ['package-lock.json'],
    });
    // Diff body must NOT appear anywhere in the JSON output.
    expect(JSON.stringify(out)).not.toContain('diff body not included');
  });

  it('includes notes title, heading, and body', () => {
    const out = formatJsonPreview(plan());
    expect(out.notes.title).toBe('v1.3.0');
    expect(out.notes.heading).toBe('## [1.3.0] - 2026-04-11');
    expect(out.notes.body).toContain('### Added');
  });

  it('includes changelog path and after, but not before', () => {
    const out = formatJsonPreview(
      plan({
        changelogBefore: 'very long existing content',
        changelogAfter: 'new content',
      }),
    );
    expect(out.changelog.path).toBe('/abs/path/CHANGELOG.md');
    expect(out.changelog.after).toBe('new content');
    expect(JSON.stringify(out)).not.toContain('very long existing content');
  });

  it('carries warnings through as an array', () => {
    const out = formatJsonPreview(plan({ warnings: ['first', 'second'] }));
    expect(out.warnings).toEqual(['first', 'second']);
  });

  it('serializes to valid JSON', () => {
    const out = formatJsonPreview(plan());
    expect(() => JSON.stringify(out)).not.toThrow();
    const round = JSON.parse(JSON.stringify(out));
    expect(round.nextVersion).toBe('1.3.0');
  });
});

// --------- formatHumanPreview ---------

describe('formatHumanPreview', () => {
  it('includes the dry-run header and footer', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('Release plan (dry run)');
    expect(out).toContain('This was a dry run');
  });

  it('shows the bump with (auto) marker', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('Bump:     minor (auto)');
  });

  it('shows the bump with (forced) marker when bumpForced is true', () => {
    const out = formatHumanPreview(plan({ bumpForced: true, bump: 'major' }));
    expect(out).toContain('Bump:     major (forced)');
  });

  it('shows current -> next version', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('Version:  1.2.2 -> 1.3.0');
  });

  it('marks the base as first-release when applicable', () => {
    const out = formatHumanPreview(
      plan({
        firstRelease: true,
        previousVersion: null,
        baseRef: 'deadbeef',
      }),
    );
    expect(out).toContain('first release');
  });

  it('includes the date', () => {
    const out = formatHumanPreview(plan({ date: '2026-04-11' }));
    expect(out).toContain('Date:     2026-04-11');
  });

  it('includes the remote webUrl when set', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('https://github.com/acme/widgets');
  });

  it('omits the Remote line when remote is null', () => {
    const out = formatHumanPreview(plan({ remote: null }));
    expect(out).not.toContain('Remote:');
  });

  it('lists each commit with shortSha, bump, and subject', () => {
    const out = formatHumanPreview(
      plan({
        commits: [
          classified({
            shortSha: 'aa1',
            subject: 'feat: add login',
            bump: 'minor',
          }),
          classified({
            shortSha: 'bb2',
            subject: 'fix: empty password',
            bump: 'patch',
          }),
        ],
      }),
    );
    expect(out).toContain('aa1');
    expect(out).toContain('feat: add login');
    expect(out).toContain('minor');
    expect(out).toContain('bb2');
    expect(out).toContain('fix: empty password');
    expect(out).toContain('patch');
  });

  it('shows an AI rationale inline when source is ai', () => {
    const out = formatHumanPreview(
      plan({
        commits: [
          classified({
            shortSha: 'aa1',
            subject: 'random internal cleanup',
            bump: 'patch',
            source: 'ai',
            rationale: 'no user-facing impact',
          }),
        ],
      }),
    );
    expect(out).toContain('[AI: no user-facing impact]');
  });

  it('shows "(none)" when there are no commits', () => {
    // Not a real case (planRelease throws on empty), but the formatter
    // should still handle it gracefully for defense in depth.
    const out = formatHumanPreview(plan({ commits: [] }));
    expect(out).toContain('Commits (0)');
    expect(out).toContain('(none)');
  });

  it('includes the notes heading and body', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('## [1.3.0] - 2026-04-11');
    expect(out).toContain('### Added');
    expect(out).toContain('- Add login');
  });

  it('shows the changelog path', () => {
    const out = formatHumanPreview(plan());
    expect(out).toContain('/abs/path/CHANGELOG.md');
    expect(out).toContain('would be updated');
  });

  it('shows the diff token summary', () => {
    const out = formatHumanPreview(
      plan({
        truncatedDiff: {
          content: 'x',
          originalTokens: 5000,
          finalTokens: 1200,
          truncated: true,
          droppedFiles: ['package-lock.json', 'dist/bundle.js'],
          notes: [],
        },
      }),
    );
    expect(out).toContain('5000 -> 1200 tokens');
    expect(out).toContain('(truncated)');
    expect(out).toContain('package-lock.json');
    expect(out).toContain('dist/bundle.js');
  });

  it('shows warnings when present', () => {
    const out = formatHumanPreview(
      plan({ warnings: ['first warning', 'second warning'] }),
    );
    expect(out).toContain('Warnings:');
    expect(out).toContain('! first warning');
    expect(out).toContain('! second warning');
  });

  it('omits the Warnings section when there are none', () => {
    const out = formatHumanPreview(plan({ warnings: [] }));
    expect(out).not.toContain('Warnings:');
  });

  it('is ASCII-only (no color codes, no emoji)', () => {
    const out = formatHumanPreview(plan({ warnings: ['something'] }));
    // Reject ESC-sequence color codes.
    expect(out).not.toContain('\u001b[');
    // Reject non-ASCII characters by code-point scan.
    for (let i = 0; i < out.length; i++) {
      expect(out.charCodeAt(i)).toBeLessThan(128);
    }
  });
});
