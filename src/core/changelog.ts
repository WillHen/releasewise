/**
 * CHANGELOG.md prepend logic — Keep a Changelog format only.
 *
 * This module is pure string manipulation: `prependChangelog` takes the
 * existing changelog text and a `ReleaseNotes` object and returns the
 * updated text. File I/O is the caller's responsibility (Step 12 wires
 * it up) so this is trivially testable and reusable from the dry-run
 * preview path.
 *
 * v1 ships `changelog` format only — the `individual` and `both` formats
 * from the plan are deferred to v1.1+.
 *
 * Insertion rules, in priority order:
 *
 *   1. If the file has a `## [Unreleased]` section, insert the new
 *      entry *after* that section's body (before the next `## ` heading
 *      or EOF). The Unreleased section itself is preserved as an empty
 *      stub so users can start accumulating the next release.
 *
 *   2. Otherwise, if the file has any `## ` heading, insert *before*
 *      the first one (newest releases on top).
 *
 *   3. Otherwise (empty file or preamble only), append the entry after
 *      whatever preamble exists, ensuring a Keep a Changelog header is
 *      present.
 *
 * Idempotence: re-running with the *same* `ReleaseNotes` on text that
 * already contains that heading is a no-op — we detect the exact
 * heading line and bail.
 */
import type { ReleaseNotes } from '../types.ts';

/**
 * Standard Keep a Changelog header we seed into new files. Matches the
 * shape recommended at https://keepachangelog.com/en/1.1.0/ — title,
 * one-line description, link to the spec, semver note, and an empty
 * Unreleased section.
 */
export const KEEP_A_CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
`;

/**
 * Build the markdown block for a single release entry. Shape:
 *
 *     ## [1.2.3] - 2026-04-11
 *
 *     ### Added
 *     - ...
 *
 * A trailing blank line is included so consecutive entries are
 * separated cleanly.
 */
export function formatEntry(notes: ReleaseNotes): string {
  const body = notes.body.trim();
  return body.length > 0
    ? `${notes.heading}\n\n${body}\n`
    : `${notes.heading}\n`;
}

/**
 * Prepend a release entry to the existing changelog text. Returns the
 * new text. Pure — no I/O, no mutation.
 *
 * If `existing` is empty or whitespace-only, a Keep a Changelog header
 * is seeded first. If the heading for `notes` is already present in
 * the file, `existing` is returned unchanged (idempotent).
 */
export function prependChangelog(
  existing: string,
  notes: ReleaseNotes,
): string {
  const entry = formatEntry(notes);
  const seeded =
    existing.trim().length === 0 ? KEEP_A_CHANGELOG_HEADER : existing;

  // Idempotence: if this exact heading already appears, do nothing. We
  // match on a full line to avoid false positives inside prose.
  if (hasHeadingLine(seeded, notes.heading)) {
    return seeded;
  }

  const lines = seeded.split('\n');
  const unreleasedIdx = findUnreleasedHeading(lines);

  if (unreleasedIdx !== -1) {
    // Insert after the Unreleased section body (before the next `## `
    // heading or EOF). This preserves the empty Unreleased stub.
    const insertAt = findNextH2(lines, unreleasedIdx + 1);
    return spliceEntry(lines, insertAt, entry);
  }

  const firstH2 = findNextH2(lines, 0);
  if (firstH2 !== -1) {
    // No Unreleased section but there are prior releases — insert
    // before the first one.
    return spliceEntry(lines, firstH2, entry);
  }

  // Preamble-only file — append at the end, with a blank line to keep
  // the preamble separated from the entry.
  const trimmedTail = trimTrailingBlankLines(lines);
  const out = [...trimmedTail, '', entry.trimEnd(), ''];
  return out.join('\n');
}

// --------- Helpers ---------

/** Find the line index of `## [Unreleased]` (case-insensitive), or -1. */
function findUnreleasedHeading(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\[unreleased\]/i.test(lines[i]!)) return i;
  }
  return -1;
}

/** Find the next line starting with `## ` from `start`, or `lines.length`. */
function findNextH2(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) return i;
  }
  return lines.length;
}

/** True if any line in `text` exactly equals `heading` (trimmed right). */
function hasHeadingLine(text: string, heading: string): boolean {
  const needle = heading.trimEnd();
  for (const line of text.split('\n')) {
    if (line.trimEnd() === needle) return true;
  }
  return false;
}

/**
 * Insert `entry` at `insertAt`, padding with a blank line above and
 * below so the result has consistent spacing regardless of how the
 * caller's file was formatted.
 */
function spliceEntry(lines: string[], insertAt: number, entry: string): string {
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  // Ensure exactly one blank line between the preceding content and
  // the new entry.
  const beforeClean = trimTrailingBlankLines(before);
  const pre = beforeClean.length > 0 ? [...beforeClean, ''] : beforeClean;

  // Ensure exactly one blank line between the new entry and the
  // following content (if any).
  const afterClean = trimLeadingBlankLines(after);
  const post = afterClean.length > 0 ? ['', ...afterClean] : afterClean;

  const entryLines = entry.replace(/\n+$/, '').split('\n');
  return [...pre, ...entryLines, ...post].join('\n');
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim().length === 0) end--;
  return lines.slice(0, end);
}

function trimLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) start++;
  return lines.slice(start);
}
