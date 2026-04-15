/**
 * `releasewise init` command.
 *
 * Detects the project (reads package.json name, checks git remote),
 * writes a `.releasewise.json` with sensible defaults, and ensures
 * `.releasewise.local.json` and `.releasewise/` are in `.gitignore`.
 *
 * Testable core is `runInit()`; citty wrapper is `initCommand`.
 */
import { defineCommand } from 'citty';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigInput } from '../core/config.ts';

// --------- Public shape ---------

export interface RunInitDeps {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  force?: boolean;
}

export interface RunInitResult {
  exitCode: number;
}

// --------- runInit ---------

export async function runInit(deps: RunInitDeps = {}): Promise<RunInitResult> {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(t));
  const cwd = deps.cwd ?? process.cwd();
  const force = deps.force ?? false;

  const configPath = join(cwd, '.releasewise.json');

  // 1. Refuse to overwrite unless --force.
  if (existsSync(configPath) && !force) {
    stderr(
      `Error: ${configPath} already exists.\n` + `Use --force to overwrite.\n`,
    );
    return { exitCode: 1 };
  }

  // 2. Detect project name from package.json.
  let projectName = 'my-project';
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
      };
      if (pkg.name) {
        projectName = pkg.name;
      }
    } catch {
      // Ignore parse errors — just use the default.
    }
  }

  // 3. Build the config.
  const config: ConfigInput & { projectName: string } = {
    projectName,
    commitMode: 'mixed',
    ai: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      maxDiffTokens: 8000,
    },
    changelog: {
      format: 'changelog',
      path: 'CHANGELOG.md',
    },
    release: {
      tagPrefix: 'v',
      pushOnRelease: true,
      createGithubRelease: true,
      tone: 'technical',
    },
  };

  // 4. Write .releasewise.json.
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  // 5. Ensure .gitignore includes .releasewise.local.json and .releasewise/.
  ensureGitignore(cwd);

  stdout(
    `Created ${configPath}\n` +
      `  Project: ${projectName}\n` +
      `  Provider: anthropic (claude-sonnet-4-6)\n` +
      `  Commit mode: mixed\n\n` +
      `Next steps:\n` +
      `  1. Set ANTHROPIC_API_KEY in your environment\n` +
      `  2. Run \`releasewise release\` to preview (runs safely by default)\n` +
      `  3. Re-run with \`--yes\` when you're ready to cut a real release\n`,
  );

  return { exitCode: 0 };
}

// --------- Helpers ---------

const GITIGNORE_ENTRIES = ['.releasewise.local.json', '.releasewise/'];

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, '.gitignore');
  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split('\n');
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => !lines.some((line) => line.trim() === entry),
  );

  if (missing.length === 0) return;

  const suffix =
    (content.length > 0 && !content.endsWith('\n') ? '\n' : '') +
    '\n# releasewise\n' +
    missing.join('\n') +
    '\n';

  writeFileSync(gitignorePath, content + suffix, 'utf8');
}

// --------- citty wrapper ---------

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Detect the project and write a .releasewise.json config.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing config if present',
      default: false,
    },
  },
  async run({ args }) {
    const result = await runInit({ force: Boolean(args.force) });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
