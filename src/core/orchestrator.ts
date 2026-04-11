/**
 * Release orchestrator — read path.
 *
 * This is the glue that stitches every other module into a single
 * `ReleasePlan`: config → commits → classification → bump → truncated
 * diff → release notes → CHANGELOG preview. It intentionally does NOT
 * touch disk or git state — callers get a plan object they can render
 * (Step 15a) and, eventually, execute (Step 12b).
 *
 * Split into two functions so tests don't need a real repo for most
 * cases:
 *
 *   1. `collectReleaseInputs()` — the only side-effecting layer. Reads
 *      git (log, diff, tags, remote) and the filesystem (package.json,
 *      existing CHANGELOG.md). One integration test covers this via a
 *      git fixture.
 *
 *   2. `planRelease()` — takes a fully-collected `ReleaseInputs` and
 *      runs the classifier, bump math, truncator, notes generation,
 *      and changelog merge. The only side effect is the AI calls made
 *      by the classifier and notes generator — both of which accept
 *      injected fakes in tests.
 *
 * The split also means `--dry-run` and a future `--estimate` mode
 * share exactly the same collection step.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AIProvider,
  BumpType,
  ClassifiedCommit,
  Commit,
  ReleaseNotes,
  RemoteInfo,
} from '../types.ts';
import { truncateDiff, type TruncatedDiff } from '../utils/diff-truncator.ts';
import { parseRemoteUrl } from '../utils/remote-url.ts';
import { prependChangelog } from './changelog.ts';
import { classifyCommits } from './classify.ts';
import type { Config } from './config.ts';
import {
  getBaseRef,
  getCommitsBetween,
  getDiffBetween,
  getHeadSha,
  getLastTag,
  getRemoteUrl,
} from './git.ts';
import { generateReleaseNotes } from './release-notes.ts';
import { bumpVersionString, resolveCurrentVersion } from './version.ts';

// --------- collectReleaseInputs ---------

export interface ReleaseInputs {
  /** Absolute repo path the inputs were collected from. */
  cwd: string;
  /** HEAD SHA at collection time. */
  headSha: string;
  /** Resolved base ref for the commit range (tag, explicit, or root SHA). */
  baseRef: string;
  /** True if there was no prior tag and no explicit `--from`. */
  firstRelease: boolean;
  /** Current version from package.json (defaults to 0.1.0 per resolveCurrentVersion). */
  currentVersion: string;
  /** Version embedded in the last tag, or null if there was no prior tag. */
  previousVersion: string | null;
  /** Commits in `baseRef..HEAD`, newest first. */
  commits: Commit[];
  /** Raw unified diff `baseRef..HEAD`. */
  rawDiff: string;
  /** Parsed `origin` remote info, or null. */
  remote: RemoteInfo | null;
  /** Existing CHANGELOG.md content (empty string if missing). */
  existingChangelog: string;
  /** Absolute path of the changelog file (whether it exists yet or not). */
  changelogPath: string;
}

export interface CollectReleaseInputsOptions {
  /** Directory to collect from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit base ref (from `--from`). Overrides the last-tag lookup. */
  fromRef?: string;
  /** Resolved config — we need `changelog.path` and `release.tagPrefix`. */
  config: Config;
}

/**
 * Read everything a release plan needs from git + the filesystem.
 *
 * Tries to keep all the "impure" work in one function so `planRelease`
 * can be tested against in-memory inputs. Any command that reads repo
 * state (`release --dry-run`, `estimate`, a future `inspect` command)
 * will share this layer.
 */
export async function collectReleaseInputs(
  opts: CollectReleaseInputsOptions,
): Promise<ReleaseInputs> {
  const cwd = opts.cwd ?? process.cwd();

  const headSha = await getHeadSha({ cwd });
  const lastTag = await getLastTag({ cwd });
  const baseRef = await getBaseRef(opts.fromRef, { cwd });
  const firstRelease =
    lastTag === null &&
    (opts.fromRef === undefined || opts.fromRef.length === 0);

  const currentVersion = await resolveCurrentVersion(cwd);
  const previousVersion =
    lastTag !== null
      ? stripTagPrefix(lastTag, opts.config.release.tagPrefix)
      : null;

  const commits = await getCommitsBetween(baseRef, 'HEAD', { cwd });
  const rawDiff = await getDiffBetween(baseRef, 'HEAD', { cwd });

  const remoteUrl = await getRemoteUrl('origin', { cwd });
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;

  const changelogPath = join(cwd, opts.config.changelog.path);
  const existingChangelog = await readFileOrEmpty(changelogPath);

  return {
    cwd,
    headSha,
    baseRef,
    firstRelease,
    currentVersion,
    previousVersion,
    commits,
    rawDiff,
    remote,
    existingChangelog,
    changelogPath,
  };
}

// --------- planRelease ---------

export interface PlanReleaseOptions {
  /** Output of `collectReleaseInputs`. */
  inputs: ReleaseInputs;
  /** Resolved config. */
  config: Config;
  /**
   * AI provider. Pass `null` for `--no-ai` (or if the provider could
   * not be constructed). The classifier and notes generator both
   * degrade to deterministic fallbacks when this is null.
   */
  provider: AIProvider | null;
  /** Force a specific bump (from `--bump major|minor|patch`). */
  forceBump?: BumpType;
  /** Prerelease label (from `--pre beta`). */
  prerelease?: string;
  /** ISO date for the release heading. Defaults to today (UTC). */
  date?: string;
  /** Commit classification mode override (from `--mode`). */
  mode?: 'conventional' | 'mixed';
}

export interface ReleasePlan {
  baseRef: string;
  headSha: string;
  firstRelease: boolean;
  currentVersion: string;
  previousVersion: string | null;
  nextVersion: string;
  /** The bump actually applied (after `forceBump` handling). */
  bump: BumpType;
  /** True if `bump` came from `forceBump` rather than commit analysis. */
  bumpForced: boolean;
  /** Commits with bump + source + (optional) rationale attached. */
  commits: ClassifiedCommit[];
  truncatedDiff: TruncatedDiff;
  remote: RemoteInfo | null;
  notes: ReleaseNotes;
  changelogPath: string;
  changelogBefore: string;
  changelogAfter: string;
  date: string;
  /** Non-fatal notices the CLI may want to surface. */
  warnings: string[];
}

/**
 * Build a `ReleasePlan` from collected inputs. Performs no writes —
 * even the changelog update is a string return, not a file write.
 *
 * Throws only when the plan genuinely can't be produced (e.g. no
 * commits in range). Everything else degrades gracefully:
 *
 *   - `manual` commit mode → warn, fall back to `conventional` (v1 scope cut)
 *   - changelog format `individual` / `both` → warn, render `changelog` only
 *   - classifier returns `none` → warn, default to `patch`
 *   - null provider → template notes + conventional-only classification
 */
export async function planRelease(
  opts: PlanReleaseOptions,
): Promise<ReleasePlan> {
  const { inputs, config, provider } = opts;
  const warnings: string[] = [];
  const date = opts.date ?? todayIso();

  if (inputs.commits.length === 0) {
    throw new Error(
      `No commits in range ${inputs.baseRef}..HEAD — nothing to release.`,
    );
  }

  // 1) Classification mode (CLI override > config > v1 fallback).
  const mode = resolveMode(opts.mode, config.commitMode, warnings);

  // 2) Warn about changelog format gaps — v1 ships `changelog` only.
  if (config.changelog.format !== 'changelog') {
    warnings.push(
      `Changelog format "${config.changelog.format}" is not supported in v1; ` +
        `using "changelog" format. (Only "changelog" is implemented today.)`,
    );
  }

  // 3) Classify commits.
  const classification = await classifyCommits({
    mode,
    commits: inputs.commits,
    provider,
    maxOutputTokens: config.ai.maxOutputTokens,
    temperature: config.ai.temperature,
  });

  // 4) Resolve the bump.
  const { bump, bumpForced } = resolveBump(
    opts.forceBump,
    classification.bump,
    warnings,
  );

  // 5) Next version.
  const nextVersion = bumpVersionString(
    inputs.currentVersion,
    bump,
    opts.prerelease,
  );

  // 6) Truncate diff.
  const truncatedDiff = truncateDiff(inputs.rawDiff, config.ai.maxDiffTokens);

  // 7) Release notes (AI path or template fallback).
  const notes = await generateReleaseNotes({
    commits: inputs.commits,
    diff: truncatedDiff.content,
    diffDroppedFiles: truncatedDiff.droppedFiles,
    version: nextVersion,
    previousVersion: inputs.previousVersion,
    date,
    provider,
    remote: inputs.remote,
    maxOutputTokens: config.ai.maxOutputTokens,
    temperature: config.ai.temperature,
  });

  // 8) Would-be CHANGELOG.md contents.
  const changelogAfter = prependChangelog(inputs.existingChangelog, notes);

  return {
    baseRef: inputs.baseRef,
    headSha: inputs.headSha,
    firstRelease: inputs.firstRelease,
    currentVersion: inputs.currentVersion,
    previousVersion: inputs.previousVersion,
    nextVersion,
    bump,
    bumpForced,
    commits: classification.commits,
    truncatedDiff,
    remote: inputs.remote,
    notes,
    changelogPath: inputs.changelogPath,
    changelogBefore: inputs.existingChangelog,
    changelogAfter,
    date,
    warnings,
  };
}

// --------- Helpers ---------

function resolveMode(
  cliMode: 'conventional' | 'mixed' | undefined,
  configMode: 'conventional' | 'mixed' | 'manual',
  warnings: string[],
): 'conventional' | 'mixed' {
  if (cliMode) return cliMode;
  if (configMode === 'manual') {
    warnings.push(
      'commitMode "manual" is not supported in v1; falling back to "conventional". ' +
        'Use --bump to force a specific bump.',
    );
    return 'conventional';
  }
  return configMode;
}

function resolveBump(
  forceBump: BumpType | undefined,
  classifierBump: BumpType,
  warnings: string[],
): { bump: BumpType; bumpForced: boolean } {
  if (forceBump) {
    return { bump: forceBump, bumpForced: true };
  }
  if (classifierBump === 'none') {
    warnings.push(
      'No commits with a recognizable bump level; defaulting to patch. ' +
        'Use --bump to override.',
    );
    return { bump: 'patch', bumpForced: false };
  }
  return { bump: classifierBump, bumpForced: false };
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

function stripTagPrefix(tag: string, prefix: string): string {
  return prefix.length > 0 && tag.startsWith(prefix)
    ? tag.slice(prefix.length)
    : tag;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
