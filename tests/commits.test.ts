import { describe, expect, it } from 'bun:test';

import {
  computeBump,
  maxBump,
  parseConventionalCommit,
} from '../src/core/commits.ts';

// Tests only care about subject/body, never the rest of the Commit shape.
function c(subject: string, body = '') {
  return { subject, body };
}

describe('parseConventionalCommit — recognized types', () => {
  it('feat: → minor', () => {
    expect(parseConventionalCommit(c('feat: add login'))).toBe('minor');
  });

  it('feature: (long form) → minor', () => {
    expect(parseConventionalCommit(c('feature: add login'))).toBe('minor');
  });

  it('feat(scope): → minor', () => {
    expect(parseConventionalCommit(c('feat(auth): add login'))).toBe('minor');
  });

  it('fix: → patch', () => {
    expect(parseConventionalCommit(c('fix: reject empty password'))).toBe(
      'patch',
    );
  });

  it('chore: → patch', () => {
    expect(parseConventionalCommit(c('chore: bump deps'))).toBe('patch');
  });

  it('docs: → patch', () => {
    expect(parseConventionalCommit(c('docs: update readme'))).toBe('patch');
  });

  it('style: → patch', () => {
    expect(parseConventionalCommit(c('style: reformat'))).toBe('patch');
  });

  it('refactor: → patch', () => {
    expect(parseConventionalCommit(c('refactor: split helper'))).toBe('patch');
  });

  it('perf: → patch', () => {
    expect(parseConventionalCommit(c('perf: cache lookup'))).toBe('patch');
  });

  it('test: → patch', () => {
    expect(parseConventionalCommit(c('test: cover edge case'))).toBe('patch');
  });

  it('build: → patch', () => {
    expect(parseConventionalCommit(c('build: switch bundler'))).toBe('patch');
  });

  it('ci: → patch', () => {
    expect(parseConventionalCommit(c('ci: pin bun version'))).toBe('patch');
  });

  it('scoped patch commits still map to patch', () => {
    expect(parseConventionalCommit(c('fix(deps): bump lodash'))).toBe('patch');
    expect(parseConventionalCommit(c('refactor(core): extract util'))).toBe(
      'patch',
    );
  });

  it('is case-insensitive on the type', () => {
    expect(parseConventionalCommit(c('FEAT: yell'))).toBe('minor');
    expect(parseConventionalCommit(c('Fix: capitalized'))).toBe('patch');
  });
});

describe('parseConventionalCommit — breaking changes', () => {
  it('feat!: → major', () => {
    expect(parseConventionalCommit(c('feat!: drop node 18'))).toBe('major');
  });

  it('fix!: → major', () => {
    expect(parseConventionalCommit(c('fix!: remove legacy endpoint'))).toBe(
      'major',
    );
  });

  it('refactor(api)!: → major (scoped bang)', () => {
    expect(parseConventionalCommit(c('refactor(api)!: new signature'))).toBe(
      'major',
    );
  });

  it('BREAKING CHANGE: footer in body → major', () => {
    expect(
      parseConventionalCommit(
        c('feat: new config', 'BREAKING CHANGE: removed old field'),
      ),
    ).toBe('major');
  });

  it('BREAKING-CHANGE: (hyphenated) footer → major', () => {
    expect(
      parseConventionalCommit(
        c('feat: new config', 'BREAKING-CHANGE: removed old field'),
      ),
    ).toBe('major');
  });

  it('is case-insensitive on BREAKING CHANGE', () => {
    expect(
      parseConventionalCommit(c('feat: whatever', 'breaking change: foo')),
    ).toBe('major');
  });

  it('BREAKING CHANGE in body beats a patch-level subject', () => {
    expect(
      parseConventionalCommit(c('fix: tiny patch', 'BREAKING CHANGE: huge')),
    ).toBe('major');
  });

  it('does not match prose like "not a breaking change" (no colon)', () => {
    expect(
      parseConventionalCommit(
        c('feat: x', 'This is not a breaking change at all'),
      ),
    ).toBe('minor');
  });
});

describe('parseConventionalCommit — unknown / malformed', () => {
  it('unknown type → none', () => {
    expect(parseConventionalCommit(c('wip: experimenting'))).toBe('none');
  });

  it('no type prefix → none', () => {
    expect(parseConventionalCommit(c('just a subject'))).toBe('none');
  });

  it('type without colon → none', () => {
    expect(parseConventionalCommit(c('feat something'))).toBe('none');
  });

  it('empty scope feat(): → none', () => {
    expect(parseConventionalCommit(c('feat(): x'))).toBe('none');
  });

  it('revert: is not in the allowlist → none', () => {
    expect(parseConventionalCommit(c('revert: old thing'))).toBe('none');
  });

  it('empty subject → none', () => {
    expect(parseConventionalCommit(c(''))).toBe('none');
  });

  it('trims leading/trailing whitespace on subject', () => {
    expect(parseConventionalCommit(c('  feat: spaced  '))).toBe('minor');
  });

  it('handles tricky punctuation in the subject description', () => {
    expect(
      parseConventionalCommit(
        c('feat(api)!: drop v1 | breaking | special\ttab'),
      ),
    ).toBe('major');
  });
});

describe('maxBump', () => {
  it('is the identity on equal inputs', () => {
    expect(maxBump('none', 'none')).toBe('none');
    expect(maxBump('patch', 'patch')).toBe('patch');
    expect(maxBump('major', 'major')).toBe('major');
  });

  it('returns the larger bump', () => {
    expect(maxBump('patch', 'minor')).toBe('minor');
    expect(maxBump('minor', 'major')).toBe('major');
    expect(maxBump('none', 'patch')).toBe('patch');
  });

  it('is commutative', () => {
    expect(maxBump('major', 'patch')).toBe('major');
    expect(maxBump('patch', 'major')).toBe('major');
  });
});

describe('computeBump', () => {
  it('returns none for an empty list', () => {
    expect(computeBump([])).toBe('none');
  });

  it('returns patch when every commit is patch-level', () => {
    expect(computeBump([c('fix: a'), c('chore: b'), c('docs: c')])).toBe(
      'patch',
    );
  });

  it('returns minor when at least one feat is present', () => {
    expect(computeBump([c('fix: a'), c('feat: b'), c('chore: c')])).toBe(
      'minor',
    );
  });

  it('returns major when any commit uses bang syntax', () => {
    expect(computeBump([c('fix: a'), c('feat!: b'), c('chore: c')])).toBe(
      'major',
    );
  });

  it('returns major from a BREAKING CHANGE footer', () => {
    expect(
      computeBump([
        c('fix: a'),
        c('feat: b', 'BREAKING CHANGE: yes'),
        c('chore: c'),
      ]),
    ).toBe('major');
  });

  it('ignores none-classified commits when real types are mixed in', () => {
    expect(computeBump([c('wip: nothing'), c('feat: a'), c('just text')])).toBe(
      'minor',
    );
  });

  it('returns none when every commit is unknown', () => {
    expect(computeBump([c('wip: a'), c('wip: b')])).toBe('none');
  });
});
