/**
 * Git module — thin wrappers around `Bun.$` for the subset of git the
 * release flow needs.
 *
 * Design notes:
 *   - Every function takes an optional `{ cwd }` so the orchestrator and
 *     tests can aim commands at any directory. Defaults to process.cwd().
 *   - Reads never mutate. Writes live in a separate group (step 3c).
 *   - Commit parsing uses ASCII record/unit separators (\x1e / \x1f) so
 *     subjects/bodies with any punctuation parse cleanly.
 *   - Errors from `Bun.$` bubble up as ShellError; callers that want a
 *     friendly fallback should use `.nothrow()` or a try/catch.
 */
import { $ } from 'bun';

import type { Commit } from '../types.ts';

// --------- Types ---------

export interface GitCommandOptions {
  /** Working directory to run the git command in. Defaults to process.cwd(). */
  cwd?: string;
}

// --------- Internal helpers ---------

const RECORD_SEP = '\x1e'; // commit boundary
const UNIT_SEP = '\x1f'; // field boundary

const COMMIT_FORMAT = [
  '%H', // full sha
  '%h', // short sha
  '%an', // author name
  '%ae', // author email
  '%aI', // author date (strict ISO 8601)
  '%s', // subject
  '%b', // body
].join(UNIT_SEP);

/** Drop a trailing record-separator (git appends one) and split. */
function splitCommitRecords(raw: string): string[] {
  const trimmed = raw.endsWith(RECORD_SEP) ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return [];
  return trimmed.split(RECORD_SEP);
}

function parseCommitRecord(record: string): Commit {
  const [sha, shortSha, author, authorEmail, date, subject, body] =
    record.split(UNIT_SEP);
  return {
    sha: sha ?? '',
    shortSha: shortSha ?? '',
    author: author ?? '',
    authorEmail: authorEmail ?? '',
    date: date ?? '',
    subject: subject ?? '',
    body: (body ?? '').trim(),
  };
}

// --------- Reads ---------

/** True if `cwd` (or any ancestor) is inside a git repository. */
export async function isGitRepo(
  opts: GitCommandOptions = {},
): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const result = await $`git rev-parse --is-inside-work-tree`
    .cwd(cwd)
    .quiet()
    .nothrow();
  return result.exitCode === 0;
}

/** Absolute path to the repository root. Throws if not inside a repo. */
export async function getRepoRoot(
  opts: GitCommandOptions = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git rev-parse --show-toplevel`.cwd(cwd).text();
  return out.trim();
}

/** Current branch name. Returns null for detached HEAD. */
export async function getCurrentBranch(
  opts: GitCommandOptions = {},
): Promise<string | null> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git symbolic-ref --quiet --short HEAD`
    .cwd(cwd)
    .nothrow()
    .text();
  const name = out.trim();
  return name.length > 0 ? name : null;
}

/** Full SHA of HEAD. */
export async function getHeadSha(
  opts: GitCommandOptions = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git rev-parse HEAD`.cwd(cwd).text();
  return out.trim();
}

/** All tags, newest first (by creation, not semver). */
export async function listTags(
  opts: GitCommandOptions = {},
): Promise<string[]> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git tag --sort=-creatordate`.cwd(cwd).text();
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Most recent tag reachable from HEAD, or null if no tag exists.
 * Uses `git describe --tags --abbrev=0` which walks the history — this is
 * what we actually want for "what was the last release on this branch".
 */
export async function getLastTag(
  opts: GitCommandOptions = {},
): Promise<string | null> {
  const cwd = opts.cwd ?? process.cwd();
  const result = await $`git describe --tags --abbrev=0`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return null;
  const name = result.stdout.toString().trim();
  return name.length > 0 ? name : null;
}

/** SHA of the first (root) commit reachable from HEAD. */
export async function getRootCommit(
  opts: GitCommandOptions = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git rev-list --max-parents=0 HEAD`.cwd(cwd).text();
  const shas = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = shas[0];
  if (!first) {
    throw new Error('No root commit found — is this an empty repository?');
  }
  return first;
}

/**
 * Resolves the "base ref" for a release's commit range.
 *   explicit > last tag > root commit
 * Exactly matches the plan's first-release handling.
 */
export async function getBaseRef(
  explicit?: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  if (explicit && explicit.length > 0) return explicit;
  const lastTag = await getLastTag(opts);
  if (lastTag) return lastTag;
  return getRootCommit(opts);
}

/**
 * Commits in the range `from..to` (exclusive..inclusive, matching git
 * log's default). Newest first. Empty array if the range has no commits.
 */
export async function getCommitsBetween(
  from: string,
  to: string,
  opts: GitCommandOptions = {},
): Promise<Commit[]> {
  const cwd = opts.cwd ?? process.cwd();
  const range = `${from}..${to}`;
  const format = `--format=${COMMIT_FORMAT}${RECORD_SEP}`;
  const out = await $`git log ${format} ${range}`.cwd(cwd).text();
  return splitCommitRecords(out).map(parseCommitRecord);
}

/** Unified diff between two refs, as a single string. */
export async function getDiffBetween(
  from: string,
  to: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git diff ${from} ${to}`.cwd(cwd).text();
  return out;
}

/** `git diff --stat` summary between two refs. */
export async function getDiffStat(
  from: string,
  to: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git diff --stat ${from} ${to}`.cwd(cwd).text();
  return out.trim();
}

/**
 * URL of the named remote (defaults to 'origin'), or null if there is no
 * such remote configured.
 */
export async function getRemoteUrl(
  remoteName = 'origin',
  opts: GitCommandOptions = {},
): Promise<string | null> {
  const cwd = opts.cwd ?? process.cwd();
  const result = await $`git remote get-url ${remoteName}`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return null;
  const url = result.stdout.toString().trim();
  return url.length > 0 ? url : null;
}

/**
 * True if the full working tree + index are clean (no staged or unstaged
 * changes anywhere).
 *
 * Use this for `releasewise undo`, which does `git reset --hard` and
 * would silently destroy any uncommitted work. Do NOT use this as a
 * pre-release gate — it's too strict and would reject the common case
 * "I have a WIP feature on the side and want to ship what's on main".
 * Use `isPathDirty` on the specific files the release is about to
 * modify instead.
 */
export async function isClean(opts: GitCommandOptions = {}): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git status --porcelain`.cwd(cwd).text();
  return out.trim().length === 0;
}

/**
 * True if `relativePath` has any staged or unstaged changes.
 *
 * Use this to check the specific files a release will overwrite
 * (typically `package.json` and `CHANGELOG.md`) so we refuse to
 * clobber uncommitted work on exactly those paths while leaving the
 * rest of the tree alone.
 *
 * Returns `false` for paths git doesn't know about (untracked files
 * don't show up here by design — a brand-new CHANGELOG.md that we're
 * about to create should not count as "dirty").
 */
export async function isPathDirty(
  relativePath: string,
  opts: GitCommandOptions = {},
): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git status --porcelain -- ${relativePath}`
    .cwd(cwd)
    .text();
  // Porcelain format: "XY path" where X/Y are status chars. An untracked
  // file is "?? path" — we filter those out so a file we're about to
  // create doesn't block the release.
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('??'));
  return lines.length > 0;
}
