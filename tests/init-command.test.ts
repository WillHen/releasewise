import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from '../src/commands/init.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'releasewise-init-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (t: string) => {
      stdout += t;
    },
    stderr: (t: string) => {
      stderr += t;
    },
    get out() {
      return stdout;
    },
    get err() {
      return stderr;
    },
  };
}

describe('runInit', () => {
  it('creates .releasewise.json with defaults', async () => {
    const sinks = capture();
    const result = await runInit({ cwd: tmpDir, ...sinks });

    expect(result.exitCode).toBe(0);
    const configPath = join(tmpDir, '.releasewise.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.commitMode).toBe('mixed');
    expect(config.ai.provider).toBe('anthropic');
    expect(config.changelog.format).toBe('changelog');
    expect(config.release.tagPrefix).toBe('v');
  });

  it('detects project name from package.json', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-cool-app' }),
    );
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    const config = JSON.parse(
      readFileSync(join(tmpDir, '.releasewise.json'), 'utf8'),
    );
    expect(config.projectName).toBe('my-cool-app');
    expect(sinks.out).toContain('my-cool-app');
  });

  it('uses default name when package.json is missing', async () => {
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    const config = JSON.parse(
      readFileSync(join(tmpDir, '.releasewise.json'), 'utf8'),
    );
    expect(config.projectName).toBe('my-project');
  });

  it('refuses to overwrite existing config without --force', async () => {
    writeFileSync(join(tmpDir, '.releasewise.json'), '{}');
    const sinks = capture();
    const result = await runInit({ cwd: tmpDir, ...sinks });

    expect(result.exitCode).toBe(1);
    expect(sinks.err).toContain('already exists');
    expect(sinks.err).toContain('--force');
  });

  it('overwrites existing config with --force', async () => {
    writeFileSync(join(tmpDir, '.releasewise.json'), '{"old": true}');
    const sinks = capture();
    const result = await runInit({ cwd: tmpDir, force: true, ...sinks });

    expect(result.exitCode).toBe(0);
    const config = JSON.parse(
      readFileSync(join(tmpDir, '.releasewise.json'), 'utf8'),
    );
    expect(config.old).toBeUndefined();
    expect(config.commitMode).toBe('mixed');
  });

  it('adds entries to .gitignore when missing', async () => {
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.releasewise.local.json');
    expect(gitignore).toContain('.releasewise/');
  });

  it('does not duplicate .gitignore entries', async () => {
    writeFileSync(
      join(tmpDir, '.gitignore'),
      'node_modules/\n.releasewise.local.json\n.releasewise/\n',
    );
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf8');
    const localCount = gitignore
      .split('\n')
      .filter((l) => l.trim() === '.releasewise.local.json').length;
    expect(localCount).toBe(1);
  });

  it('appends to existing .gitignore without clobbering', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('dist/');
    expect(gitignore).toContain('.releasewise.local.json');
  });

  it('prints next steps', async () => {
    const sinks = capture();
    await runInit({ cwd: tmpDir, ...sinks });

    expect(sinks.out).toContain('ANTHROPIC_API_KEY');
    expect(sinks.out).toContain('releasewise release');
    expect(sinks.out).toContain('--yes');
  });
});
