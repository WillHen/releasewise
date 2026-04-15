import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bumpVersion,
  bumpVersionString,
  formatVersion,
  isPre1,
  parseVersion,
  readPackageVersion,
  resolveCurrentVersion,
  writePackageVersion,
} from '../src/core/version.ts';

// --------- Fixtures ---------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'releasewise-version-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------- parseVersion ---------

describe('parseVersion', () => {
  it('parses a plain release', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it('parses 0.0.0', () => {
    expect(parseVersion('0.0.0')).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
    });
  });

  it('parses a prerelease', () => {
    expect(parseVersion('1.2.3-beta.0')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: { label: 'beta', counter: 0 },
    });
  });

  it('parses a prerelease with a multi-digit counter', () => {
    expect(parseVersion('1.0.0-rc.42')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: { label: 'rc', counter: 42 },
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseVersion('  1.0.0  ')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: null,
    });
  });

  it('throws on empty input', () => {
    expect(() => parseVersion('')).toThrow(/Invalid version/);
  });

  it('throws on a two-part version', () => {
    expect(() => parseVersion('1.0')).toThrow(/Invalid version/);
  });

  it('throws on a leading v prefix', () => {
    expect(() => parseVersion('v1.0.0')).toThrow(/Invalid version/);
  });

  it('throws on a prerelease without a counter', () => {
    expect(() => parseVersion('1.0.0-beta')).toThrow(/Invalid version/);
  });

  it('throws on a multi-segment prerelease', () => {
    expect(() => parseVersion('1.0.0-beta.0.1')).toThrow(/Invalid version/);
  });

  it('throws on build metadata', () => {
    expect(() => parseVersion('1.0.0+build.1')).toThrow(/Invalid version/);
  });

  it('throws on non-semver garbage', () => {
    expect(() => parseVersion('not-semver')).toThrow(/Invalid version/);
  });
});

// --------- formatVersion ---------

describe('formatVersion', () => {
  it('formats a plain release', () => {
    expect(
      formatVersion({ major: 1, minor: 2, patch: 3, prerelease: null }),
    ).toBe('1.2.3');
  });

  it('formats a prerelease', () => {
    expect(
      formatVersion({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: { label: 'beta', counter: 7 },
      }),
    ).toBe('1.2.3-beta.7');
  });

  it('round-trips parseVersion → formatVersion', () => {
    for (const s of [
      '1.0.0',
      '0.0.1',
      '10.20.30',
      '1.0.0-beta.0',
      '2.3.4-rc.11',
    ]) {
      expect(formatVersion(parseVersion(s))).toBe(s);
    }
  });
});

// --------- bumpVersion ---------

describe('bumpVersion — plain releases', () => {
  it('patch bumps the patch', () => {
    expect(bumpVersionString('1.2.3', 'patch')).toBe('1.2.4');
  });

  it('minor bumps minor and resets patch', () => {
    expect(bumpVersionString('1.2.3', 'minor')).toBe('1.3.0');
  });

  it('major bumps major and resets minor + patch', () => {
    expect(bumpVersionString('1.2.3', 'major')).toBe('2.0.0');
  });

  it('none is a no-op', () => {
    expect(bumpVersionString('1.2.3', 'none')).toBe('1.2.3');
  });
});

describe('bumpVersion — entering a prerelease', () => {
  it('patch + pre → X.Y.(Z+1)-pre.0', () => {
    expect(bumpVersionString('1.0.0', 'patch', 'beta')).toBe('1.0.1-beta.0');
  });

  it('minor + pre → X.(Y+1).0-pre.0', () => {
    expect(bumpVersionString('1.0.0', 'minor', 'beta')).toBe('1.1.0-beta.0');
  });

  it('major + pre → (X+1).0.0-pre.0', () => {
    expect(bumpVersionString('1.0.0', 'major', 'beta')).toBe('2.0.0-beta.0');
  });

  it('none + pre tags the existing version as a prerelease', () => {
    expect(bumpVersionString('1.2.3', 'none', 'beta')).toBe('1.2.3-beta.0');
  });
});

describe('bumpVersion — continuing a prerelease', () => {
  it('same label + patch increments the counter', () => {
    expect(bumpVersionString('1.0.1-beta.0', 'patch', 'beta')).toBe(
      '1.0.1-beta.1',
    );
  });

  it('same label + none also increments the counter', () => {
    expect(bumpVersionString('1.0.1-beta.3', 'none', 'beta')).toBe(
      '1.0.1-beta.4',
    );
  });

  it('same label + minor moves the base and resets the counter', () => {
    expect(bumpVersionString('1.0.1-beta.5', 'minor', 'beta')).toBe(
      '1.1.0-beta.0',
    );
  });

  it('same label + major moves the base and resets the counter', () => {
    expect(bumpVersionString('1.0.1-beta.5', 'major', 'beta')).toBe(
      '2.0.0-beta.0',
    );
  });

  it('switching labels keeps the base and resets the counter', () => {
    expect(bumpVersionString('1.0.1-alpha.2', 'patch', 'beta')).toBe(
      '1.0.1-beta.0',
    );
  });
});

describe('bumpVersion — graduation', () => {
  it('patch graduates the current prerelease to its base', () => {
    expect(bumpVersionString('1.0.1-beta.1', 'patch')).toBe('1.0.1');
  });

  it('none also graduates to the base', () => {
    expect(bumpVersionString('1.0.1-beta.1', 'none')).toBe('1.0.1');
  });

  it('minor graduates and applies a minor bump', () => {
    expect(bumpVersionString('1.0.1-beta.1', 'minor')).toBe('1.1.0');
  });

  it('major graduates and applies a major bump', () => {
    expect(bumpVersionString('1.0.1-beta.1', 'major')).toBe('2.0.0');
  });
});

describe('bumpVersion — pure data API', () => {
  it('returns a Version object when given a Version object', () => {
    expect(
      bumpVersion({ major: 1, minor: 0, patch: 0, prerelease: null }, 'minor'),
    ).toEqual({ major: 1, minor: 1, patch: 0, prerelease: null });
  });
});

// --------- isPre1 ---------

describe('isPre1', () => {
  it('returns true for 0.x.y', () => {
    expect(isPre1('0.1.0')).toBe(true);
    expect(isPre1('0.2.1')).toBe(true);
    expect(isPre1('0.99.99')).toBe(true);
  });

  it('returns false for 1.x.y and above', () => {
    expect(isPre1('1.0.0')).toBe(false);
    expect(isPre1('2.3.4')).toBe(false);
  });

  it('ignores the prerelease suffix', () => {
    expect(isPre1('0.1.0-beta.0')).toBe(true);
    expect(isPre1('1.0.0-rc.1')).toBe(false);
  });

  it('throws on invalid input', () => {
    expect(() => isPre1('not-semver')).toThrow(/Invalid version/);
  });
});

// --------- readPackageVersion ---------

describe('readPackageVersion', () => {
  it('returns the version string when present', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}\n');
      expect(await readPackageVersion(dir)).toBe('1.2.3');
    });
  });

  it('returns null when the field is missing', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
      expect(await readPackageVersion(dir)).toBeNull();
    });
  });

  it('returns null for an empty version string', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":""}\n');
      expect(await readPackageVersion(dir)).toBeNull();
    });
  });

  it('returns null for a non-string version', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":1}\n');
      expect(await readPackageVersion(dir)).toBeNull();
    });
  });

  it('throws when the version is a non-semver string', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":"not-semver"}\n');
      await expect(readPackageVersion(dir)).rejects.toThrow(/Invalid version/);
    });
  });

  it('throws when package.json is malformed JSON', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{not-json');
      await expect(readPackageVersion(dir)).rejects.toThrow();
    });
  });

  it('throws when package.json does not exist', async () => {
    await withTempDir(async (dir) => {
      await expect(readPackageVersion(dir)).rejects.toThrow();
    });
  });
});

// --------- writePackageVersion ---------

describe('writePackageVersion', () => {
  it('writes a new version and preserves other fields + indent + newline', async () => {
    await withTempDir(async (dir) => {
      const original =
        '{\n  "name": "x",\n  "version": "1.0.0",\n  "scripts": {\n    "a": "b"\n  }\n}\n';
      writeFileSync(join(dir, 'package.json'), original);

      await writePackageVersion(dir, '1.0.1');
      const after = await readFile(join(dir, 'package.json'), 'utf8');

      expect(after).toContain('"version": "1.0.1"');
      expect(after).toContain('"name": "x"');
      expect(after).toContain('"scripts"');
      expect(after).toContain('    "a": "b"'); // nested 4-space indent preserved
      expect(after.endsWith('\n')).toBe(true);
    });
  });

  it('preserves tab indentation when the original uses tabs', async () => {
    await withTempDir(async (dir) => {
      const original = '{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n';
      writeFileSync(join(dir, 'package.json'), original);

      await writePackageVersion(dir, '1.0.1');
      const after = await readFile(join(dir, 'package.json'), 'utf8');

      expect(after).toContain('\t"version": "1.0.1"');
      expect(after).toContain('\t"name": "x"');
    });
  });

  it('omits the trailing newline when the original did not have one', async () => {
    await withTempDir(async (dir) => {
      const original = '{\n  "version": "1.0.0"\n}';
      writeFileSync(join(dir, 'package.json'), original);

      await writePackageVersion(dir, '1.0.1');
      const after = await readFile(join(dir, 'package.json'), 'utf8');

      expect(after.endsWith('\n')).toBe(false);
    });
  });

  it('refuses to write an invalid version', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
      await expect(writePackageVersion(dir, 'not-semver')).rejects.toThrow(
        /Invalid version/,
      );
    });
  });
});

// --------- resolveCurrentVersion ---------

describe('resolveCurrentVersion', () => {
  it('returns the version from package.json when present', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}\n');
      expect(await resolveCurrentVersion(dir)).toBe('1.2.3');
    });
  });

  it('defaults to 0.1.0 when the version is missing', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
      expect(await resolveCurrentVersion(dir)).toBe('0.1.0');
    });
  });

  it('defaults to 0.1.0 when the version is the sentinel 0.0.0', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"version":"0.0.0"}\n');
      expect(await resolveCurrentVersion(dir)).toBe('0.1.0');
    });
  });
});
