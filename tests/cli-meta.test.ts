import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import { resolveVersion } from '../src/cli-meta.ts';

describe('resolveVersion', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'releasewise-cli-meta-'));
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('returns the current package.json version by default', () => {
    expect(resolveVersion()).toBe(pkg.version);
  });

  it('reads the version from the supplied package.json at runtime', () => {
    // Proves the drift case: a fixture version the build-time import
    // cannot know about is still surfaced, because the read happens at
    // call time.
    const path = join(fixtureDir, 'package.json');
    writeFileSync(
      path,
      JSON.stringify({ name: 'fixture', version: '9.9.9-fixture' }),
      'utf8',
    );
    expect(resolveVersion(path)).toBe('9.9.9-fixture');
  });

  it('falls back to the build-time version when the file is missing', () => {
    expect(resolveVersion(join(fixtureDir, 'nope.json'))).toBe(pkg.version);
  });

  it('falls back when the file is not valid JSON', () => {
    const path = join(fixtureDir, 'package.json');
    writeFileSync(path, 'not json', 'utf8');
    expect(resolveVersion(path)).toBe(pkg.version);
  });

  it('falls back when the version field is missing or empty', () => {
    const missing = join(fixtureDir, 'missing.json');
    writeFileSync(missing, JSON.stringify({ name: 'x' }), 'utf8');
    expect(resolveVersion(missing)).toBe(pkg.version);

    const empty = join(fixtureDir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ name: 'x', version: '' }), 'utf8');
    expect(resolveVersion(empty)).toBe(pkg.version);
  });
});
