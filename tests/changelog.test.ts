import { describe, expect, it } from 'bun:test';

import {
  KEEP_A_CHANGELOG_HEADER,
  formatEntry,
  prependChangelog,
} from '../src/core/changelog.ts';
import type { ReleaseNotes } from '../src/types.ts';

// --------- Fixtures ---------

function notes(partial: Partial<ReleaseNotes> = {}): ReleaseNotes {
  return {
    title: 'v1.2.3',
    heading: '## [1.2.3] - 2026-04-11',
    body: '### Added\n- New thing',
    ...partial,
  };
}

// --------- formatEntry ---------

describe('formatEntry', () => {
  it('joins heading and body with a blank line', () => {
    expect(formatEntry(notes())).toBe(
      '## [1.2.3] - 2026-04-11\n\n### Added\n- New thing\n',
    );
  });

  it('trims a body with surrounding whitespace', () => {
    expect(formatEntry(notes({ body: '\n\n### Added\n- x\n\n' }))).toBe(
      '## [1.2.3] - 2026-04-11\n\n### Added\n- x\n',
    );
  });

  it('emits only the heading when the body is empty', () => {
    expect(formatEntry(notes({ body: '' }))).toBe('## [1.2.3] - 2026-04-11\n');
  });

  it('treats whitespace-only body as empty', () => {
    expect(formatEntry(notes({ body: '   \n\n' }))).toBe(
      '## [1.2.3] - 2026-04-11\n',
    );
  });
});

// --------- prependChangelog: empty file ---------

describe('prependChangelog — empty or missing file', () => {
  it('seeds a Keep a Changelog header when input is empty', () => {
    const out = prependChangelog('', notes());
    expect(out).toContain('# Changelog');
    expect(out).toContain('Keep a Changelog');
    expect(out).toContain('Semantic Versioning');
    expect(out).toContain('## [Unreleased]');
    expect(out).toContain('## [1.2.3] - 2026-04-11');
    expect(out).toContain('### Added');
    expect(out).toContain('- New thing');
  });

  it('seeds a header when input is whitespace only', () => {
    const out = prependChangelog('   \n\n\t', notes());
    expect(out).toContain('# Changelog');
    expect(out).toContain('## [1.2.3] - 2026-04-11');
  });

  it('places the new entry after the Unreleased section in a fresh file', () => {
    const out = prependChangelog('', notes());
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const entryIdx = out.indexOf('## [1.2.3]');
    expect(unreleasedIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeGreaterThan(unreleasedIdx);
  });
});

// --------- prependChangelog: Unreleased section present ---------

describe('prependChangelog — with Unreleased section', () => {
  it('inserts after an empty Unreleased section', () => {
    const existing = `# Changelog

## [Unreleased]

## [1.2.2] - 2026-04-01

### Fixed
- Old thing
`;
    const out = prependChangelog(existing, notes());
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const newIdx = out.indexOf('## [1.2.3]');
    const oldIdx = out.indexOf('## [1.2.2]');
    expect(unreleasedIdx).toBeLessThan(newIdx);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('preserves the Unreleased section stub', () => {
    const existing = `# Changelog

## [Unreleased]

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    expect(out).toContain('## [Unreleased]');
  });

  it('inserts after Unreleased even when Unreleased has accumulated notes', () => {
    const existing = `# Changelog

## [Unreleased]

### Added
- Pending feature

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const pendingIdx = out.indexOf('Pending feature');
    const newIdx = out.indexOf('## [1.2.3]');
    const oldIdx = out.indexOf('## [1.2.2]');
    expect(unreleasedIdx).toBeLessThan(pendingIdx);
    expect(pendingIdx).toBeLessThan(newIdx);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('matches Unreleased case-insensitively', () => {
    const existing = `# Changelog

## [UNRELEASED]

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    const unreleasedIdx = out.indexOf('## [UNRELEASED]');
    const newIdx = out.indexOf('## [1.2.3]');
    expect(unreleasedIdx).toBeLessThan(newIdx);
  });
});

// --------- prependChangelog: no Unreleased, prior entries ---------

describe('prependChangelog — no Unreleased, prior entries', () => {
  it('inserts before the first existing release heading', () => {
    const existing = `# Changelog

## [1.2.2] - 2026-04-01

### Fixed
- Old thing

## [1.2.1] - 2026-03-30

### Fixed
- Older thing
`;
    const out = prependChangelog(existing, notes());
    const newIdx = out.indexOf('## [1.2.3]');
    const prevIdx = out.indexOf('## [1.2.2]');
    const olderIdx = out.indexOf('## [1.2.1]');
    expect(newIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(prevIdx);
    expect(prevIdx).toBeLessThan(olderIdx);
  });

  it('preserves the preamble above the first existing entry', () => {
    const existing = `# Changelog

Custom preamble text.

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    expect(out).toContain('Custom preamble text.');
    const preambleIdx = out.indexOf('Custom preamble text.');
    const newIdx = out.indexOf('## [1.2.3]');
    expect(preambleIdx).toBeLessThan(newIdx);
  });
});

// --------- prependChangelog: preamble only ---------

describe('prependChangelog — preamble only', () => {
  it('appends after a header with no existing entries', () => {
    const existing = `# Changelog

All notable changes.
`;
    const out = prependChangelog(existing, notes());
    expect(out).toContain('# Changelog');
    expect(out).toContain('All notable changes.');
    expect(out).toContain('## [1.2.3] - 2026-04-11');
    const headerIdx = out.indexOf('# Changelog');
    const newIdx = out.indexOf('## [1.2.3]');
    expect(headerIdx).toBeLessThan(newIdx);
  });
});

// --------- Idempotence ---------

describe('prependChangelog — idempotence', () => {
  it('is a no-op when the exact heading already exists', () => {
    const existing = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-04-11

### Added
- Already there
`;
    const out = prependChangelog(existing, notes());
    expect(out).toBe(existing);
  });

  it('re-running the same prepend is a no-op on the second call', () => {
    const once = prependChangelog('', notes());
    const twice = prependChangelog(once, notes());
    expect(twice).toBe(once);
  });

  it('does not match the heading against prose', () => {
    // A string that looks like the heading but is embedded in prose
    // should NOT trigger the idempotence bail.
    const existing = `# Changelog

Note: we skipped ## [1.2.3] - 2026-04-11 due to a typo.

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    // Should have inserted a real entry — now two occurrences.
    const count = out.split('## [1.2.3] - 2026-04-11').length - 1;
    expect(count).toBe(2);
  });
});

// --------- Spacing ---------

describe('prependChangelog — spacing', () => {
  it('inserts exactly one blank line between prior content and the new entry', () => {
    const existing = `# Changelog

## [Unreleased]

## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    // No triple newlines should appear anywhere in the output.
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('handles trailing whitespace on existing content gracefully', () => {
    const existing = `# Changelog

## [Unreleased]




## [1.2.2] - 2026-04-01
`;
    const out = prependChangelog(existing, notes());
    expect(out).not.toMatch(/\n\n\n/);
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const newIdx = out.indexOf('## [1.2.3]');
    expect(unreleasedIdx).toBeLessThan(newIdx);
  });

  it('handles body with multiple sections', () => {
    const body = '### Added\n- A thing\n\n### Fixed\n- A fix';
    const out = prependChangelog('', notes({ body }));
    expect(out).toContain('### Added');
    expect(out).toContain('- A thing');
    expect(out).toContain('### Fixed');
    expect(out).toContain('- A fix');
  });
});

// --------- KEEP_A_CHANGELOG_HEADER ---------

describe('KEEP_A_CHANGELOG_HEADER', () => {
  it('includes the standard Keep a Changelog boilerplate', () => {
    expect(KEEP_A_CHANGELOG_HEADER).toContain('# Changelog');
    expect(KEEP_A_CHANGELOG_HEADER).toContain('Keep a Changelog');
    expect(KEEP_A_CHANGELOG_HEADER).toContain('Semantic Versioning');
    expect(KEEP_A_CHANGELOG_HEADER).toContain('## [Unreleased]');
  });
});
