/**
 * Release-plan renderers.
 *
 * Two formats:
 *
 *   - `formatHumanPreview(plan)` — multi-section plaintext for
 *     the default `releasewise release` preview. Deliberately
 *     ASCII-only and color-free so snapshot tests and CI logs
 *     stay stable.
 *
 *   - `formatJsonPreview(plan)` — a JSON-serializable object for
 *     `--json`. This is the stable contract external tooling will
 *     depend on, so the shape is narrowed to exactly the fields a
 *     caller would need (no internal diff buffers or file contents
 *     beyond what's useful).
 *
 * Both are pure functions — they take a `ReleasePlan` and return a
 * value. No process/env/fs access here; the CLI layer decides where
 * the output goes.
 */
import type { ReleasePlan } from '../core/orchestrator.ts';
import type { BumpType, RemoteInfo } from '../types.ts';

// --------- JSON output shape ---------

export interface JsonPreviewCommit {
  shortSha: string;
  subject: string;
  bump: BumpType;
  source: 'conventional' | 'ai' | 'manual';
  rationale?: string;
}

export interface JsonPreviewDiff {
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  droppedFiles: string[];
}

export interface JsonPreviewNotes {
  title: string;
  heading: string;
  body: string;
}

export interface JsonPreviewChangelog {
  path: string;
  after: string;
}

export interface JsonPreview {
  dryRun: boolean;
  baseRef: string;
  headSha: string;
  firstRelease: boolean;
  currentVersion: string;
  previousVersion: string | null;
  nextVersion: string;
  bump: BumpType;
  bumpForced: boolean;
  date: string;
  commitCount: number;
  commits: JsonPreviewCommit[];
  remote: RemoteInfo | null;
  diff: JsonPreviewDiff;
  notes: JsonPreviewNotes;
  changelog: JsonPreviewChangelog;
  warnings: string[];
}

/**
 * Shape a `ReleasePlan` into the stable JSON-serializable contract
 * emitted by `release --json` (preview mode). Strips the `changelogBefore`
 * (consumers can re-read the file) and the full truncated diff body
 * (only its metadata is useful downstream).
 *
 * `dryRun` defaults to `true` so the preview (the original caller) keeps
 * its existing shape. Pass `{ dryRun: false }` when the same shape is
 * reused to emit the pre-execute plan on a real release.
 */
export function formatJsonPreview(
  plan: ReleasePlan,
  options: { dryRun?: boolean } = {},
): JsonPreview {
  const { dryRun = true } = options;
  return {
    dryRun,
    baseRef: plan.baseRef,
    headSha: plan.headSha,
    firstRelease: plan.firstRelease,
    currentVersion: plan.currentVersion,
    previousVersion: plan.previousVersion,
    nextVersion: plan.nextVersion,
    bump: plan.bump,
    bumpForced: plan.bumpForced,
    date: plan.date,
    commitCount: plan.commits.length,
    commits: plan.commits.map((c) => ({
      shortSha: c.shortSha,
      subject: c.subject,
      bump: c.bump,
      source: c.source,
      ...(c.rationale !== undefined ? { rationale: c.rationale } : {}),
    })),
    remote: plan.remote,
    diff: {
      originalTokens: plan.truncatedDiff.originalTokens,
      finalTokens: plan.truncatedDiff.finalTokens,
      truncated: plan.truncatedDiff.truncated,
      droppedFiles: plan.truncatedDiff.droppedFiles,
    },
    notes: {
      title: plan.notes.title,
      heading: plan.notes.heading,
      body: plan.notes.body,
    },
    changelog: {
      path: plan.changelogPath,
      after: plan.changelogAfter,
    },
    warnings: plan.warnings,
  };
}

// --------- Human-readable output ---------

const RULE = '-'.repeat(60);

/**
 * Render a human-readable multi-section preview of a release plan.
 * ASCII-only, no colors — keep it snapshot-stable and CI-friendly.
 *
 * `dryRun` defaults to `true` — the original use case. Pass
 * `{ dryRun: false }` to reuse the same layout as the pre-execute plan
 * on a real release: the header drops "(dry run)" and the "no files
 * were modified" footer is omitted.
 *
 * Layout (dry run):
 *
 *     ------------------------------------------------------------
 *     Release plan (dry run)
 *     ------------------------------------------------------------
 *
 *     Bump:     minor (auto)
 *     Version:  1.2.2 -> 1.3.0
 *     Base:     v1.2.2
 *     Date:     2026-04-11
 *
 *     Commits (3):
 *       abc1234  minor  feat: add login
 *       def5678  patch  fix: reject empty password
 *
 *     Release notes:
 *       ## [1.3.0] - 2026-04-11
 *
 *       ### Added
 *       - Add login
 *
 *     Changelog:
 *       /abs/path/CHANGELOG.md (would be updated)
 *
 *     Warnings:
 *       ! message one
 */
export function formatHumanPreview(
  plan: ReleasePlan,
  options: { dryRun?: boolean } = {},
): string {
  const { dryRun = true } = options;
  const lines: string[] = [];
  lines.push(RULE);
  lines.push(dryRun ? 'Release plan (dry run)' : 'Release plan');
  lines.push(RULE);
  lines.push('');

  // --- Header block ---
  lines.push(...renderHeader(plan));
  lines.push('');

  // --- Commits ---
  lines.push(...renderCommits(plan));
  lines.push('');

  // --- Release notes ---
  lines.push('Release notes:');
  lines.push(indent(plan.notes.heading, 2));
  lines.push('');
  for (const bodyLine of plan.notes.body.split('\n')) {
    lines.push(indent(bodyLine, 2));
  }
  lines.push('');

  // --- Changelog ---
  lines.push('Changelog:');
  lines.push(`  ${plan.changelogPath} (would be updated)`);
  lines.push('');

  // --- Diff summary ---
  lines.push(...renderDiffSummary(plan));

  // --- Warnings (trailing so they're the last thing the user sees) ---
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of plan.warnings) {
      lines.push(`  ! ${w}`);
    }
  }

  // --- Footer (dry run only) ---
  if (dryRun) {
    lines.push('');
    lines.push(RULE);
    lines.push('This was a dry run. No files or git state were modified.');
    lines.push(RULE);
  }

  return lines.join('\n');
}

// --------- Helpers ---------

function renderHeader(plan: ReleasePlan): string[] {
  const bumpLabel = plan.bumpForced
    ? `${plan.bump} (forced)`
    : `${plan.bump} (auto)`;
  const baseLabel = plan.firstRelease
    ? `${plan.baseRef} (first release)`
    : plan.baseRef;
  const lines = [
    `Bump:     ${bumpLabel}`,
    `Version:  ${plan.currentVersion} -> ${plan.nextVersion}`,
    `Base:     ${baseLabel}`,
    `Date:     ${plan.date}`,
  ];
  if (plan.remote) {
    lines.push(`Remote:   ${plan.remote.webUrl}`);
  }
  return lines;
}

function renderCommits(plan: ReleasePlan): string[] {
  const lines: string[] = [];
  lines.push(`Commits (${plan.commits.length}):`);
  if (plan.commits.length === 0) {
    lines.push('  (none)');
    return lines;
  }
  // Column widths: sha (7) + bump (max 5: "major", "minor", "patch", "none")
  const bumpWidth = 5;
  for (const c of plan.commits) {
    const bumpCol = c.bump.padEnd(bumpWidth);
    const rationale =
      c.source === 'ai' && c.rationale ? `  [AI: ${c.rationale}]` : '';
    lines.push(`  ${c.shortSha.padEnd(8)}${bumpCol}  ${c.subject}${rationale}`);
  }
  return lines;
}

function renderDiffSummary(plan: ReleasePlan): string[] {
  const d = plan.truncatedDiff;
  const lines = [
    `Diff: ${d.originalTokens} -> ${d.finalTokens} tokens${
      d.truncated ? ' (truncated)' : ''
    }`,
  ];
  if (d.droppedFiles.length > 0) {
    lines.push(`  dropped: ${d.droppedFiles.join(', ')}`);
  }
  return lines;
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text.length === 0 ? '' : `${pad}${text}`;
}
