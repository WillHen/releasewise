import { describe, expect, it } from 'bun:test';

import type { RemoteInfo } from '../src/types.ts';
import { enrichPrLinks } from '../src/utils/pr-linker.ts';

const github: RemoteInfo = {
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
};

const ghe: RemoteInfo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'r',
  webUrl: 'https://git.example.com/team/r',
};

describe('enrichPrLinks — matches', () => {
  it('links a bare #N reference', () => {
    expect(enrichPrLinks('Fixed a thing #123', github)).toBe(
      'Fixed a thing [#123](https://github.com/acme/widgets/pull/123)',
    );
  });

  it('links a parenthesized (#N)', () => {
    expect(enrichPrLinks('Added thing (#456)', github)).toBe(
      'Added thing ([#456](https://github.com/acme/widgets/pull/456))',
    );
  });

  it('preserves the Closes keyword', () => {
    expect(enrichPrLinks('Closes #789', github)).toBe(
      'Closes [#789](https://github.com/acme/widgets/pull/789)',
    );
  });

  it('preserves Fixes (case-insensitive keyword)', () => {
    expect(enrichPrLinks('fixes #42', github)).toBe(
      'fixes [#42](https://github.com/acme/widgets/pull/42)',
    );
  });

  it('links multiple references in one string', () => {
    expect(enrichPrLinks('a #1, b #22, c #333', github)).toBe(
      'a [#1](https://github.com/acme/widgets/pull/1), ' +
        'b [#22](https://github.com/acme/widgets/pull/22), ' +
        'c [#333](https://github.com/acme/widgets/pull/333)',
    );
  });

  it('links at the start of a bullet line', () => {
    expect(enrichPrLinks('- #17 fix something', github)).toBe(
      '- [#17](https://github.com/acme/widgets/pull/17) fix something',
    );
  });

  it('links at the very start of the string', () => {
    expect(enrichPrLinks('#1 is a thing', github)).toBe(
      '[#1](https://github.com/acme/widgets/pull/1) is a thing',
    );
  });

  it('links GH Enterprise URLs', () => {
    expect(enrichPrLinks('Closes #1', ghe)).toBe(
      'Closes [#1](https://git.example.com/team/r/pull/1)',
    );
  });

  it('links across newlines', () => {
    const input = 'first line #1\nsecond line #2';
    expect(enrichPrLinks(input, github)).toBe(
      'first line [#1](https://github.com/acme/widgets/pull/1)\n' +
        'second line [#2](https://github.com/acme/widgets/pull/2)',
    );
  });
});

describe('enrichPrLinks — non-matches', () => {
  it('leaves already-linked references alone (idempotent)', () => {
    const input = 'See [#123](https://github.com/acme/widgets/pull/123)';
    expect(enrichPrLinks(input, github)).toBe(input);
  });

  it('re-running on enriched text is a no-op', () => {
    const once = enrichPrLinks('Closes #1', github);
    const twice = enrichPrLinks(once, github);
    expect(twice).toBe(once);
  });

  it('does not link mid-word references like abc#123', () => {
    expect(enrichPrLinks('object abc#123 is foo', github)).toBe(
      'object abc#123 is foo',
    );
  });

  it('does not link MD5-style prefixes', () => {
    expect(enrichPrLinks('hash MD5#42', github)).toBe('hash MD5#42');
  });

  it('leaves a hash without digits alone (heading marker)', () => {
    expect(enrichPrLinks('## heading\nsome text', github)).toBe(
      '## heading\nsome text',
    );
  });

  it('returns input unchanged when remote is null', () => {
    expect(enrichPrLinks('Fixes #1', null)).toBe('Fixes #1');
  });

  it('returns empty string unchanged', () => {
    expect(enrichPrLinks('', github)).toBe('');
  });

  it('does not link a bare # with no digits', () => {
    expect(enrichPrLinks('a # b', github)).toBe('a # b');
  });

  it('does not link refs inside an inline code span', () => {
    // This is the dogfood bug: a bullet describing the PR linker feature
    // had a `#123` in a code span and the linker rewrote the documentation.
    const input = 'convert bare `#123` references into links';
    expect(enrichPrLinks(input, github)).toBe(input);
  });

  it('still links refs outside a code span on the same line', () => {
    const input = 'see `#123` syntax, used in #456 here';
    expect(enrichPrLinks(input, github)).toBe(
      'see `#123` syntax, used in [#456](https://github.com/acme/widgets/pull/456) here',
    );
  });

  it('handles multiple code spans on one line', () => {
    const input = 'both `#1` and `#2` are examples, real ref is #3';
    expect(enrichPrLinks(input, github)).toBe(
      'both `#1` and `#2` are examples, real ref is [#3](https://github.com/acme/widgets/pull/3)',
    );
  });

  it('a backtick code span containing a ref is unchanged across lines', () => {
    // A stray unclosed backtick on one line must not consume into the next,
    // so a real ref on line 2 still gets linked.
    const input = 'a lonely ` backtick\nreal ref #9';
    expect(enrichPrLinks(input, github)).toBe(
      'a lonely ` backtick\nreal ref [#9](https://github.com/acme/widgets/pull/9)',
    );
  });
});
