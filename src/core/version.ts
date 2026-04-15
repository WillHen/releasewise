/**
 * Version module — semver parsing, bumping (incl. --pre prerelease cycle),
 * and package.json read/write.
 *
 * Supported semver shape (narrow on purpose):
 *   MAJOR.MINOR.PATCH                       e.g. 1.2.3
 *   MAJOR.MINOR.PATCH-LABEL.COUNTER         e.g. 1.2.3-beta.0
 *
 * Out of scope for v1 (parseVersion throws): build metadata (`+buildinfo`),
 * multi-segment prereleases (`1.0.0-beta.1.2`), non-numeric counters, or a
 * leading `v` prefix. Callers that accept tag names like `v1.2.3` must
 * strip the prefix before parsing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BumpType } from '../types.ts';

// --------- Types ---------

export interface Prerelease {
  label: string;
  counter: number;
}

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: Prerelease | null;
}

// --------- Parsing / formatting ---------

const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9]+)\.(\d+))?$/;

/** Parse a semver string into its components. Throws on invalid input. */
export function parseVersion(input: string): Version {
  const match = VERSION_REGEX.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid version: ${JSON.stringify(input)}`);
  }
  const [, maj, min, pat, label, counter] = match;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease:
      label !== undefined && counter !== undefined
        ? { label, counter: Number(counter) }
        : null,
  };
}

/** Format a `Version` object back into a semver string. */
export function formatVersion(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) {
    return `${base}-${v.prerelease.label}.${v.prerelease.counter}`;
  }
  return base;
}

// --------- Bump math ---------

/**
 * Apply a bump to a semver version, optionally producing (or continuing)
 * a prerelease.
 *
 * Behavior table (assuming `pre = 'beta'` where shown):
 *
 *   current          bump    pre    →  next
 *   ---------------  ------  -----  -------------
 *   1.0.0            patch   —      1.0.1
 *   1.0.0            minor   —      1.1.0
 *   1.0.0            major   —      2.0.0
 *   1.0.0            patch   beta   1.0.1-beta.0
 *   1.0.0            minor   beta   1.1.0-beta.0
 *   1.0.1-beta.0     patch   beta   1.0.1-beta.1   (same label → ++counter)
 *   1.0.1-beta.0     minor   beta   1.1.0-beta.0   (bigger bump → new base)
 *   1.0.1-alpha.2    patch   beta   1.0.1-beta.0   (switch label → reset counter)
 *   1.0.1-beta.0     patch   —      1.0.1          (graduation)
 *   1.0.1-beta.0     minor   —      1.1.0          (graduation + minor)
 *   1.0.1-beta.0     major   —      2.0.0          (graduation + major)
 *   1.2.3            none    —      1.2.3          (no-op)
 *   1.2.3            none    beta   1.2.3-beta.0   (tag existing version)
 */
export function bumpVersion(
  current: Version,
  bump: BumpType,
  pre?: string,
): Version {
  const base = {
    major: current.major,
    minor: current.minor,
    patch: current.patch,
  };

  // Case 1: graduation — current has prerelease, caller isn't passing pre.
  if (current.prerelease && !pre) {
    switch (bump) {
      case 'major':
        return { major: base.major + 1, minor: 0, patch: 0, prerelease: null };
      case 'minor':
        return {
          major: base.major,
          minor: base.minor + 1,
          patch: 0,
          prerelease: null,
        };
      case 'patch':
      case 'none':
        // Graduation: the prerelease base IS the target release.
        // 1.0.1-beta.N + patch (no pre) → 1.0.1, not 1.0.2 — we're
        // releasing the patch we've been staging, not bumping past it.
        // `none` behaves the same way: "ship whatever's been staged".
        return { ...base, prerelease: null };
    }
  }

  // Case 2: continuing / switching a prerelease cycle.
  if (current.prerelease && pre) {
    const sameLabel = current.prerelease.label === pre;
    switch (bump) {
      case 'major':
        return {
          major: base.major + 1,
          minor: 0,
          patch: 0,
          prerelease: { label: pre, counter: 0 },
        };
      case 'minor':
        return {
          major: base.major,
          minor: base.minor + 1,
          patch: 0,
          prerelease: { label: pre, counter: 0 },
        };
      case 'patch':
      case 'none':
        // Staying in prerelease mode at the same base.
        if (sameLabel) {
          // Same label → increment counter: beta.0 → beta.1.
          return {
            ...base,
            prerelease: {
              label: pre,
              counter: current.prerelease.counter + 1,
            },
          };
        }
        // Switching labels (alpha → beta, etc.) resets the counter at
        // the same base.
        return { ...base, prerelease: { label: pre, counter: 0 } };
    }
  }

  // Case 3: full release → full release (optionally entering a prerelease).
  let next: { major: number; minor: number; patch: number };
  switch (bump) {
    case 'major':
      next = { major: base.major + 1, minor: 0, patch: 0 };
      break;
    case 'minor':
      next = { major: base.major, minor: base.minor + 1, patch: 0 };
      break;
    case 'patch':
      next = { major: base.major, minor: base.minor, patch: base.patch + 1 };
      break;
    case 'none':
      next = base;
      break;
  }
  return pre
    ? { ...next, prerelease: { label: pre, counter: 0 } }
    : { ...next, prerelease: null };
}

/**
 * Convenience: parse → bump → format. The orchestrator deals in strings,
 * so this is the form it actually calls.
 */
export function bumpVersionString(
  current: string,
  bump: BumpType,
  pre?: string,
): string {
  return formatVersion(bumpVersion(parseVersion(current), bump, pre));
}

/**
 * True when `version` is a pre-1.0 release (major === 0). The ecosystem
 * convention (semantic-release, release-please, changesets) is that
 * breaking changes pre-1.0 bump the minor, not the major, so projects
 * don't accidentally graduate to 1.0.0 before they're ready.
 */
export function isPre1(version: string): boolean {
  return parseVersion(version).major === 0;
}

// --------- package.json I/O ---------

const PACKAGE_JSON = 'package.json';

/**
 * Detect the indentation used by an existing JSON file by peeking at the
 * first indented key. Falls back to 2 spaces if the file is a one-liner
 * or otherwise unindented.
 */
function detectIndent(raw: string): string | number {
  const match = /^([ \t]+)"/m.exec(raw);
  return match ? match[1]! : 2;
}

async function readPackageJson(cwd: string): Promise<{
  pkg: Record<string, unknown>;
  raw: string;
}> {
  const path = join(cwd, PACKAGE_JSON);
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PACKAGE_JSON} does not contain a JSON object`);
  }
  return { pkg: parsed as Record<string, unknown>, raw };
}

/**
 * Read the `version` field from `cwd/package.json`.
 *
 * Returns:
 *   - the trimmed version string if the field is present and parses as semver
 *   - `null` if the field is missing or not a non-empty string
 *
 * Throws if `package.json` can't be read, isn't valid JSON, or the version
 * field is a non-empty string that doesn't parse (we refuse to silently
 * eat garbage — the user wants to know their file is malformed).
 */
export async function readPackageVersion(cwd: string): Promise<string | null> {
  const { pkg } = await readPackageJson(cwd);
  if (!('version' in pkg)) return null;
  const v = pkg.version;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  // Validate — throws on garbage.
  parseVersion(trimmed);
  return trimmed;
}

/**
 * Write `next` into the `version` field of `cwd/package.json`.
 *
 * Preserves the file's detected indent and trailing newline. Validates
 * `next` before writing — we refuse to write a non-semver string.
 */
export async function writePackageVersion(
  cwd: string,
  next: string,
): Promise<void> {
  parseVersion(next); // throws on garbage
  const { pkg, raw } = await readPackageJson(cwd);
  pkg.version = next;
  const indent = detectIndent(raw);
  const hasTrailingNewline = raw.endsWith('\n');
  const body =
    JSON.stringify(pkg, null, indent) + (hasTrailingNewline ? '\n' : '');
  await writeFile(join(cwd, PACKAGE_JSON), body, 'utf8');
}

/**
 * Resolve the version to use as the base for bumping. Returns what's in
 * `package.json`, defaulting to `0.1.0` if the field is missing or the
 * sentinel `0.0.0` — both of which indicate "no prior release".
 *
 * This matches the plan's first-release rule: a project that has never
 * been released gets `0.1.0` as its first real version, regardless of
 * the bump type the user passed.
 */
export async function resolveCurrentVersion(cwd: string): Promise<string> {
  const v = await readPackageVersion(cwd);
  if (v === null || v === '0.0.0') return '0.1.0';
  return v;
}
