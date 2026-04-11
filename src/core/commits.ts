/**
 * Conventional-commit parsing and bump detection.
 *
 * Implements the Conventional Commits v1 spec plus the two extensions we
 * actually need:
 *
 *   - Bang syntax (`feat!:`, `refactor(api)!:`) marks the commit as a
 *     breaking change → major bump.
 *   - A `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer anywhere in the
 *     body marks the commit as breaking → major bump.
 *
 * Any commit whose subject doesn't match a known type falls through to
 * `none`. For mixed mode this is "parser doesn't know, ask the AI". For
 * pure conventional mode it's effectively "ignore this commit".
 */
import type { BumpType, Commit } from '../types.ts';

// --- Regexes ---

// feat!:, fix!:, refactor(api)!: — any \w+ type, optional (scope), then `!:`
const BANG_REGEX = /^\w+(\(.+\))?!:/i;

// feat: / feature: / feat(scope): — optional (scope)
const FEAT_REGEX = /^(feat|feature)(\(.+\))?:/i;

// Patch-level types from CLAUDE.md's allowlist.
const PATCH_REGEX =
  /^(fix|chore|docs|style|refactor|perf|test|build|ci)(\(.+\))?:/i;

// `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer. Spec says it must live in
// the footer of the body; we match it permissively so a footer-looking line
// anywhere in the body counts.
const BREAKING_FOOTER_REGEX = /BREAKING[\s-]CHANGE:/i;

// --- Core parser ---

/**
 * Classify a single commit's bump level from its subject + body.
 *
 * Precedence, highest first:
 *   1. bang syntax in subject   → major
 *   2. BREAKING CHANGE: footer  → major
 *   3. feat / feature           → minor
 *   4. fix / chore / docs / …   → patch
 *   5. everything else          → none
 */
export function parseConventionalCommit(
  commit: Pick<Commit, 'subject' | 'body'>,
): BumpType {
  const subject = (commit.subject ?? '').trim();
  const body = commit.body ?? '';

  if (BANG_REGEX.test(subject)) return 'major';
  if (BREAKING_FOOTER_REGEX.test(body)) return 'major';
  if (FEAT_REGEX.test(subject)) return 'minor';
  if (PATCH_REGEX.test(subject)) return 'patch';
  return 'none';
}

// --- Aggregation ---

const BUMP_RANK: Record<BumpType, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

/** Return whichever of `a` and `b` is the larger semver bump. */
export function maxBump(a: BumpType, b: BumpType): BumpType {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

/**
 * Highest bump level across a set of commits, short-circuiting on the
 * first `major`. Returns `none` for an empty list.
 */
export function computeBump(
  commits: Pick<Commit, 'subject' | 'body'>[],
): BumpType {
  let result: BumpType = 'none';
  for (const c of commits) {
    result = maxBump(result, parseConventionalCommit(c));
    if (result === 'major') return result;
  }
  return result;
}
