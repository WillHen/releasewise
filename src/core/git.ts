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

/**
 * Reject argv values that could be reinterpreted as flags by git/gh, or
 * that contain control characters. Bun's `$` template already prevents
 * *shell* injection by passing each interpolation as a distinct argv
 * entry — but the invoked tool still parses argv, so a value like "-d"
 * passed where a tag name is expected becomes a `--delete` flag.
 *
 * Applied to every user-controlled argv: tag names, refs, remote names,
 * and ref-range endpoints. Commit messages are exempt because they're
 * the value of a `-m` flag (single-argv) and legitimately start with '-'.
 * Paths are exempt because we always pass them after a `--` separator.
 */
export function assertSafeArg(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`git: ${field} must be a non-empty string`);
  }
  if (value.startsWith('-')) {
    throw new Error(
      `git: ${field} must not begin with '-' (got ${JSON.stringify(value)})`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    throw new Error(`git: ${field} contains control characters`);
  }
}

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

/**
 * Split git log output into individual commit records.
 *
 * Git always terminates stdout with a trailing newline, so the raw
 * output for N commits looks like `r1\x1e\nr2\x1e\n`. Splitting on
 * `\x1e` gives N+1 pieces: the real records (all but the first
 * preceded by the inter-commit `\n`) plus an empty trailing piece.
 * Strip leading newlines from each piece and drop empties.
 */
function splitCommitRecords(raw: string): string[] {
  return raw
    .split(RECORD_SEP)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.length > 0);
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

/**
 * Resolve a ref expression (SHA, tag, branch, `<sha>^`, …) to its full
 * commit SHA. Returns null if the ref doesn't exist — use this to probe
 * for refs that may or may not resolve (e.g. the parent of a potential
 * root commit before a `reset --hard`).
 */
export async function resolveRef(
  ref: string,
  opts: GitCommandOptions = {},
): Promise<string | null> {
  assertSafeArg(ref, 'ref');
  const cwd = opts.cwd ?? process.cwd();
  const result = await $`git rev-parse --verify ${ref}`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.toString().trim();
  return sha.length > 0 ? sha : null;
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
  if (explicit && explicit.length > 0) {
    assertSafeArg(explicit, 'baseRef');
    return explicit;
  }
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
  assertSafeArg(from, 'from');
  assertSafeArg(to, 'to');
  const cwd = opts.cwd ?? process.cwd();
  const range = `${from}..${to}`;
  const format = `--format=${COMMIT_FORMAT}${RECORD_SEP}`;
  const out = await $`git log ${format} ${range}`.cwd(cwd).text();
  return splitCommitRecords(out).map(parseCommitRecord);
}

/**
 * Every commit reachable from `to`, newest first. Use this for the
 * first-release case (no prior tag) where `from..to` would drop the
 * root commit — git's `..` operator is left-exclusive, so `rootSha..HEAD`
 * silently excludes the root.
 */
export async function getAllCommitsUpTo(
  to: string,
  opts: GitCommandOptions = {},
): Promise<Commit[]> {
  assertSafeArg(to, 'to');
  const cwd = opts.cwd ?? process.cwd();
  const format = `--format=${COMMIT_FORMAT}${RECORD_SEP}`;
  const out = await $`git log ${format} ${to}`.cwd(cwd).text();
  return splitCommitRecords(out).map(parseCommitRecord);
}

/** Unified diff between two refs, as a single string. */
export async function getDiffBetween(
  from: string,
  to: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  assertSafeArg(from, 'from');
  assertSafeArg(to, 'to');
  const cwd = opts.cwd ?? process.cwd();
  const out = await $`git diff ${from} ${to}`.cwd(cwd).text();
  return out;
}

/**
 * Cumulative diff from an empty baseline up to `to`. For the first
 * release, `getDiffBetween(rootSha, 'HEAD')` omits the root commit's
 * own changes; diffing against the empty tree includes them.
 *
 * The baseline SHA is computed at runtime via `git hash-object -t tree
 * /dev/null` so this works in both SHA-1 and SHA-256 repos.
 */
export async function getDiffFromEmpty(
  to: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  assertSafeArg(to, 'to');
  const cwd = opts.cwd ?? process.cwd();
  const emptyTree = (
    await $`git hash-object -t tree /dev/null`.cwd(cwd).text()
  ).trim();
  const out = await $`git diff ${emptyTree} ${to}`.cwd(cwd).text();
  return out;
}

/** `git diff --stat` summary between two refs. */
export async function getDiffStat(
  from: string,
  to: string,
  opts: GitCommandOptions = {},
): Promise<string> {
  assertSafeArg(from, 'from');
  assertSafeArg(to, 'to');
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
  assertSafeArg(remoteName, 'remoteName');
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

// --------- Writes ---------

/**
 * Stage the given paths and create a commit with the given message.
 *
 * Uses the `git commit <path>...` form so only those paths are included;
 * any staged or unstaged changes to other files are left exactly as they
 * were. Returns the new HEAD SHA.
 */
export async function commit(
  message: string,
  paths: string[],
  opts: GitCommandOptions = {},
): Promise<string> {
  if (paths.length === 0) {
    throw new Error('commit() requires at least one path');
  }
  const cwd = opts.cwd ?? process.cwd();
  // Explicit `git add` first — `git commit -- <paths>` only handles
  // tracked files. New files (e.g. a brand-new CHANGELOG.md) need to be
  // staged before they can be committed.
  await $`git add -- ${paths}`.cwd(cwd).quiet();
  await $`git commit -m ${message} -- ${paths}`.cwd(cwd).quiet();
  return getHeadSha(opts);
}

/**
 * Create an annotated tag (or lightweight if no message) pointing at
 * HEAD. Throws if the tag already exists — callers should decide up
 * front whether to delete-and-recreate.
 */
export async function createTag(
  name: string,
  message?: string,
  opts: GitCommandOptions = {},
): Promise<void> {
  assertSafeArg(name, 'tag name');
  const cwd = opts.cwd ?? process.cwd();
  if (message && message.length > 0) {
    await $`git tag -a ${name} -m ${message}`.cwd(cwd).quiet();
  } else {
    await $`git tag ${name}`.cwd(cwd).quiet();
  }
}

/**
 * Delete a local tag. Used by `releasewise undo` to reverse a tag that
 * was created but never pushed. Silent no-op if the tag doesn't exist.
 */
export async function deleteTag(
  name: string,
  opts: GitCommandOptions = {},
): Promise<void> {
  assertSafeArg(name, 'tag name');
  const cwd = opts.cwd ?? process.cwd();
  await $`git tag -d ${name}`.cwd(cwd).quiet().nothrow();
}

export interface PushOptions extends GitCommandOptions {
  /** Remote name, defaults to 'origin'. */
  remote?: string;
  /** Explicit branch/ref to push. Defaults to the current branch. */
  ref?: string;
  /** Also push tags reachable from the pushed commits. Default: true. */
  followTags?: boolean;
}

/**
 * Push commits (and, by default, follow-tags) to the configured remote.
 *
 * `--follow-tags` pushes any annotated tags that are reachable from the
 * commits being pushed and don't yet exist on the remote — which is
 * exactly what a release wants: one atomic push of the bump commit +
 * its tag, so if the push fails both are cleanly absent on the remote.
 */
export async function push(opts: PushOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const remote = opts.remote ?? 'origin';
  const followTags = opts.followTags ?? true;

  assertSafeArg(remote, 'remote');
  if (opts.ref) assertSafeArg(opts.ref, 'ref');

  if (opts.ref) {
    if (followTags) {
      await $`git push --follow-tags ${remote} ${opts.ref}`.cwd(cwd).quiet();
    } else {
      await $`git push ${remote} ${opts.ref}`.cwd(cwd).quiet();
    }
  } else if (followTags) {
    await $`git push --follow-tags ${remote}`.cwd(cwd).quiet();
  } else {
    await $`git push ${remote}`.cwd(cwd).quiet();
  }
}

/**
 * `git reset --hard <ref>` — destroys uncommitted changes. Only called
 * by `releasewise undo`, which first verifies the tree is clean via
 * `isClean()`. Do NOT call this from anywhere else.
 */
export async function resetHard(
  ref: string,
  opts: GitCommandOptions = {},
): Promise<void> {
  assertSafeArg(ref, 'ref');
  const cwd = opts.cwd ?? process.cwd();
  await $`git reset --hard ${ref}`.cwd(cwd).quiet();
}

// --------- Dirty-path check (used by release pre-flight) ---------

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
