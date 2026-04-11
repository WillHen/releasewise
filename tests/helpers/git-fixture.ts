/**
 * Git fixture helpers for integration tests.
 *
 * Each test gets a fresh temp directory with `git init`'d already, a
 * deterministic user.name / user.email, and a default branch of `main`.
 * Use the returned helpers to stage files and create commits/tags
 * without needing to think about git config.
 */
import { $ } from 'bun';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GitFixture {
  /** Absolute path to the repo root. */
  dir: string;
  /** Write a file relative to the repo and stage it. */
  writeFile(relative: string, contents: string): void;
  /** Commit all staged changes with the given subject. */
  commit(subject: string, body?: string): Promise<string>;
  /** Create an annotated tag pointing at HEAD. */
  tag(name: string, message?: string): Promise<void>;
  /** Add a remote URL for the given name (default: origin). */
  addRemote(url: string, name?: string): Promise<void>;
  /** Remove the fixture directory. */
  cleanup(): void;
}

export async function createGitFixture(): Promise<GitFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'releasewise-git-'));

  // `git init -b main` for a deterministic default branch across hosts.
  // Local user config keeps commits working without touching global git.
  // Values with spaces MUST be interpolated as variables so Bun.$ quotes
  // them as a single argument.
  const userName = 'Releasewise Test';
  const userEmail = 'test@releasewise.dev';
  await $`git init -b main`.cwd(dir).quiet();
  await $`git config user.email ${userEmail}`.cwd(dir).quiet();
  await $`git config user.name ${userName}`.cwd(dir).quiet();
  await $`git config commit.gpgsign false`.cwd(dir).quiet();
  await $`git config tag.gpgsign false`.cwd(dir).quiet();

  return {
    dir,
    writeFile(relative, contents) {
      const full = join(dir, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    },
    async commit(subject, body) {
      await $`git add -A`.cwd(dir).quiet();
      const message = body ? `${subject}\n\n${body}` : subject;
      await $`git commit -m ${message}`.cwd(dir).quiet();
      const out = await $`git rev-parse HEAD`.cwd(dir).text();
      return out.trim();
    },
    async tag(name, message) {
      if (message) {
        await $`git tag -a ${name} -m ${message}`.cwd(dir).quiet();
      } else {
        await $`git tag ${name}`.cwd(dir).quiet();
      }
    },
    async addRemote(url, name = 'origin') {
      await $`git remote add ${name} ${url}`.cwd(dir).quiet();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
