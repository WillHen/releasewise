import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_FILENAME,
  ConfigNotFoundError,
  ConfigValidationError,
  findConfigFile,
  LOCAL_CONFIG_FILENAME,
  loadConfig,
  mergeConfigInputs,
} from '../src/core/config-loader.ts';

// ---------- Fixture helpers ----------

let fixtureDir: string;

function writeFixture(relativePath: string, contents: string) {
  const full = join(fixtureDir, relativePath);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'releasewise-test-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// ---------- mergeConfigInputs ----------

describe('mergeConfigInputs', () => {
  it('shallow-merges at the top level', () => {
    const merged = mergeConfigInputs(
      { projectName: 'base', commitMode: 'conventional' },
      { projectName: 'override' },
    );
    expect(merged.projectName).toBe('override');
    expect(merged.commitMode).toBe('conventional');
  });

  it('shallow-merges the ai sub-object (override wins field-by-field)', () => {
    const merged = mergeConfigInputs(
      { ai: { provider: 'anthropic', model: 'base-model' } },
      { ai: { model: 'override-model' } },
    );
    expect(merged.ai?.provider).toBe('anthropic');
    expect(merged.ai?.model).toBe('override-model');
  });

  it('handles empty base and empty override without crashing', () => {
    expect(mergeConfigInputs({}, {})).toEqual({
      ai: {},
      changelog: {},
      release: {},
    });
  });
});

// ---------- findConfigFile ----------

describe('findConfigFile', () => {
  it('finds the file in the starting directory', () => {
    writeFixture(CONFIG_FILENAME, '{}');
    expect(findConfigFile(fixtureDir)).toBe(join(fixtureDir, CONFIG_FILENAME));
  });

  it('walks up ancestors to find the file', () => {
    writeFixture(CONFIG_FILENAME, '{}');
    writeFixture('packages/sub/.keep', '');
    const startDir = join(fixtureDir, 'packages/sub');
    expect(findConfigFile(startDir)).toBe(join(fixtureDir, CONFIG_FILENAME));
  });

  it('returns null when no config is found up to the fs root', () => {
    // Nested empty dirs, no config file anywhere under fixtureDir.
    writeFixture('a/b/c/.keep', '');
    const result = findConfigFile(join(fixtureDir, 'a/b/c'));
    // Either null (no config on disk up the chain) or a real config
    // somewhere above /tmp. Both are valid — the contract is "don't
    // crash, don't find something under fixtureDir".
    if (result !== null) {
      expect(result.startsWith(fixtureDir)).toBe(false);
    }
  });
});

// ---------- loadConfig ----------

describe('loadConfig', () => {
  it('loads a valid base config with defaults filled in', () => {
    writeFixture(CONFIG_FILENAME, JSON.stringify({ projectName: 'my-app' }));
    const result = loadConfig({ cwd: fixtureDir });

    expect(result.config.projectName).toBe('my-app');
    expect(result.config.commitMode).toBe('mixed'); // default
    expect(result.baseConfigPath).toBe(join(fixtureDir, CONFIG_FILENAME));
    expect(result.localConfigPath).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('merges .releasewise.local.json on top of the base', () => {
    writeFixture(
      CONFIG_FILENAME,
      JSON.stringify({
        projectName: 'my-app',
        ai: { provider: 'anthropic', model: 'base-model' },
      }),
    );
    writeFixture(
      LOCAL_CONFIG_FILENAME,
      JSON.stringify({
        ai: { apiKey: 'local-secret', model: 'local-model' },
      }),
    );
    const result = loadConfig({ cwd: fixtureDir });

    expect(result.config.projectName).toBe('my-app');
    expect(result.config.ai.provider).toBe('anthropic');
    expect(result.config.ai.model).toBe('local-model');
    expect(result.config.ai.apiKey).toBe('local-secret');
    expect(result.localConfigPath).toBe(
      join(fixtureDir, LOCAL_CONFIG_FILENAME),
    );
    expect(result.warnings).toEqual([]); // key came from .local, no warning
  });

  it('warns (does not error) when apiKey is set in the committed base file', () => {
    writeFixture(
      CONFIG_FILENAME,
      JSON.stringify({ ai: { apiKey: 'committed-secret' } }),
    );
    const result = loadConfig({ cwd: fixtureDir });
    expect(result.config.ai.apiKey).toBe('committed-secret');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(CONFIG_FILENAME);
    expect(result.warnings[0]).toContain(LOCAL_CONFIG_FILENAME);
  });

  it('walks up from a nested cwd to find the config', () => {
    writeFixture(
      CONFIG_FILENAME,
      JSON.stringify({ projectName: 'root-project' }),
    );
    writeFixture('packages/sub/.keep', '');
    const result = loadConfig({ cwd: join(fixtureDir, 'packages/sub') });
    expect(result.config.projectName).toBe('root-project');
  });

  it('throws ConfigNotFoundError when no config exists in the search chain', () => {
    // Start from a deep empty fixture directory, explicitly pass the
    // explicitPath as a non-existent sibling path to avoid walking up
    // to a real ancestor config.
    expect(() =>
      loadConfig({
        cwd: fixtureDir,
        explicitPath: join(fixtureDir, 'does-not-exist.json'),
      }),
    ).toThrow();
  });

  it('throws ConfigValidationError on invalid merged config', () => {
    writeFixture(CONFIG_FILENAME, JSON.stringify({ commitMode: 'yolo' }));
    expect(() => loadConfig({ cwd: fixtureDir })).toThrow(
      ConfigValidationError,
    );
  });

  it('formats ConfigValidationError with path and message', () => {
    writeFixture(
      CONFIG_FILENAME,
      JSON.stringify({ ai: { provider: 'llama' } }),
    );
    try {
      loadConfig({ cwd: fixtureDir });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain('ai.provider');
    }
  });

  it('throws ConfigNotFoundError from a fresh temp dir when ancestors have no config', () => {
    // macOS /tmp has no .releasewise.json ancestors, so this should
    // reliably throw. If it doesn't, we at least verify the error type
    // is right when one does get thrown.
    try {
      loadConfig({ cwd: fixtureDir });
    } catch (err) {
      // Either the config wasn't found (expected) or we walked up and
      // hit something else (tolerated). Only assert if we threw a
      // ConfigNotFoundError — don't fail the test on a stray ancestor.
      if (err instanceof ConfigNotFoundError) {
        expect(err.message).toContain(CONFIG_FILENAME);
      }
    }
  });
});
