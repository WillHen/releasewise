/**
 * Token-budget-aware diff shrinking.
 *
 * We send unified diffs to an AI provider to ask it to write release notes.
 * Raw diffs for a real release are usually way larger than what we can
 * afford to send — lockfile churn alone can blow past any budget. This
 * module takes a raw `git diff` and returns a budgeted version that fits
 * under a token cap while keeping the parts the model actually needs.
 *
 * Strategy, in order. Each tier is tried only if the previous one didn't
 * get us under budget:
 *
 *   Tier -1 — privacy redaction (unconditional)
 *     If the caller passed `redactPaths`, drop any file whose path
 *     matches one of those globs first, regardless of budget. These
 *     files NEVER reach the AI — this is the carve-out for regulated
 *     data, licensed third-party code, or sensitive IP.
 *
 *   Tier 0 — fast path
 *     If the whole diff is already under budget, return it unchanged.
 *
 *   Tier 1 — drop noisy files
 *     Generated or machine-churn files (lockfiles, minified bundles,
 *     sourcemaps, dist/build output) never tell the reviewer anything
 *     useful. Drop them outright with a one-line note per file.
 *
 *   Tier 2 — drop the biggest remaining file bodies
 *     Sort what's left by byte size and drop whole file bodies largest
 *     first, replacing each with a one-line "[…N lines omitted]" stub.
 *     The file header line is kept so the model still sees "this file
 *     changed". Stop as soon as we're under budget.
 *
 *   Tier 3 — drop whole files
 *     If dropping bodies still wasn't enough (many tiny files), drop
 *     whole file entries and append a footer listing them.
 *
 * Per-hunk trimming is deliberately out of scope for v1 — it adds a lot of
 * code for marginal quality gain over "drop the largest bodies first".
 *
 * The budget is a token count, which we translate to a byte/char budget
 * via `estimateTokens` (see token-estimator.ts). We only need to be right
 * within ~20%, so this is fine.
 */
import { Glob } from 'bun';

import { estimateTokens } from './token-estimator.ts';

// --------- Types ---------

export interface TruncatedDiff {
  /** The possibly-shrunk diff body to send to the AI. */
  content: string;
  /** Estimated tokens of the original input diff. */
  originalTokens: number;
  /** Estimated tokens of `content`. */
  finalTokens: number;
  /** True if any trimming happened. */
  truncated: boolean;
  /** Paths of files whose bodies were dropped (any tier). */
  droppedFiles: string[];
  /**
   * Paths dropped specifically by `redactPaths` privacy redaction.
   * These were excluded for confidentiality, not to fit budget; surface
   * them separately so the preview can distinguish the two reasons.
   */
  redactedFiles: string[];
  /** Human-readable notes about what was dropped and why. */
  notes: string[];
}

export interface TruncateDiffOptions {
  /**
   * Glob patterns (Bun glob syntax) for paths whose diff content must
   * never be sent to the AI. Matched files are dropped from the diff
   * before any budget-driven truncation, regardless of size — both the
   * body and the `diff --git` header are stripped from `content`.
   *
   * The matched paths still appear in the returned `redactedFiles` and
   * `notes` so the caller can render them in a preview to the user;
   * it's the caller's job to decide what to forward to the AI (the
   * orchestrator filters them out of the AI-facing "files omitted"
   * hint).
   */
  redactPaths?: string[];
}

// --------- Noise list ---------

// Files we always drop first. This list is intentionally conservative:
// anything here is either a lockfile or generated output that a human
// reviewer would also skip.
const NOISE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
]);

const NOISE_SUFFIXES = ['.min.js', '.min.css', '.js.map', '.css.map'] as const;

const NOISE_DIR_SEGMENTS = new Set([
  'dist',
  'build',
  'coverage',
  'node_modules',
  '.next',
  '.turbo',
]);

function isNoisyPath(path: string): boolean {
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  if (NOISE_BASENAMES.has(basename)) return true;
  for (const suffix of NOISE_SUFFIXES) {
    if (basename.endsWith(suffix)) return true;
  }
  for (const seg of segments.slice(0, -1)) {
    if (NOISE_DIR_SEGMENTS.has(seg)) return true;
  }
  return false;
}

/**
 * Compile redact globs once per call. Returns a predicate that tests a
 * file path against the set of patterns. Callers with no patterns get a
 * predicate that always returns false, which folds out at call sites.
 *
 * Bun's `Glob` uses minimatch-style syntax: `*` matches a single path
 * segment, `**` crosses segment boundaries, `?` is a single char,
 * `[abc]` is a character class. This matches users' intuition coming
 * from `.gitignore` / minimatch, so we don't reinvent a matcher.
 */
function buildRedactionMatcher(
  patterns: string[] | undefined,
): (path: string) => boolean {
  if (!patterns || patterns.length === 0) return () => false;
  const globs = patterns.map((p) => new Glob(p));
  return (path: string) => globs.some((g) => g.match(path));
}

// --------- Parsing ---------

interface DiffFile {
  /** Best-effort path label for the file ("b" side of the diff). */
  path: string;
  /** The full raw diff chunk for this file, including the `diff --git` header. */
  raw: string;
}

/**
 * Split a unified diff into per-file chunks. Anything before the first
 * `diff --git` line is returned as a leading preamble (usually empty).
 *
 * This parser is intentionally lenient: it only needs to find the file
 * boundaries and read a path. We don't try to understand hunks.
 */
function splitDiff(diff: string): { preamble: string; files: DiffFile[] } {
  if (diff.length === 0) return { preamble: '', files: [] };

  const lines = diff.split('\n');
  const files: DiffFile[] = [];
  let preamble = '';
  let current: string[] | null = null;

  const flush = () => {
    if (current === null) return;
    const raw = current.join('\n');
    files.push({ path: extractPath(raw), raw });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
    } else if (current !== null) {
      current.push(line);
    } else {
      preamble += (preamble.length > 0 ? '\n' : '') + line;
    }
  }
  flush();

  return { preamble, files };
}

/**
 * Pull a path out of a `diff --git` chunk. Prefers the `+++ b/…` line
 * (post-image), falls back to the `diff --git a/x b/x` header, then to
 * `(unknown)` if neither is present.
 */
function extractPath(raw: string): string {
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length);
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      return line.slice('+++ '.length);
    }
  }
  // Fall back to the header: `diff --git a/foo b/foo`
  const header = lines[0] ?? '';
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (match) return match[2]!;
  return '(unknown)';
}

// --------- Truncation ---------

/**
 * Replace a file chunk's body with a one-line omission stub, keeping only
 * the `diff --git` header so the model still sees the file changed.
 */
function stubFile(file: DiffFile): string {
  const lines = file.raw.split('\n');
  const header = lines[0] ?? `diff --git a/${file.path} b/${file.path}`;
  const bodyLineCount = Math.max(0, lines.length - 1);
  return `${header}\n[… ${bodyLineCount} lines omitted from ${file.path} …]`;
}

function joinDiff(preamble: string, files: { raw: string }[]): string {
  const body = files.map((f) => f.raw).join('\n');
  if (preamble.length === 0) return body;
  return `${preamble}\n${body}`;
}

/**
 * Shrink a raw diff to fit under `budgetTokens`. Returns a `TruncatedDiff`
 * describing what (if anything) was removed.
 *
 * Contract:
 * - `budgetTokens` must be positive. A zero or negative budget throws.
 * - The returned `content` is never larger than the input.
 * - The returned `finalTokens` may exceed `budgetTokens` if *every* file
 *   has been dropped and the preamble + footer still don't fit. That's
 *   a pathological case (budget smaller than a few hundred chars) and
 *   we don't try to recover from it here — the caller should raise the
 *   budget or skip AI entirely.
 */
export function truncateDiff(
  diff: string,
  budgetTokens: number,
  options: TruncateDiffOptions = {},
): TruncatedDiff {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new Error(
      `truncateDiff: budgetTokens must be a positive number, got ${budgetTokens}`,
    );
  }

  const originalTokens = estimateTokens(diff);
  const isRedacted = buildRedactionMatcher(options.redactPaths);
  const hasRedactPatterns =
    (options.redactPaths?.length ?? 0) > 0 && diff.length > 0;

  // Tier -1: privacy redaction. Runs before the fast path so a
  // small-but-sensitive file is still removed when the rest of the
  // diff would have fit unchanged. We have to split the diff to check.
  if (hasRedactPatterns) {
    const split = splitDiff(diff);
    const redacted = split.files.filter((f) => isRedacted(f.path));
    if (redacted.length > 0) {
      const kept = split.files.filter((f) => !isRedacted(f.path));
      const redactedPaths = redacted.map((f) => f.path);
      const notes = redactedPaths.map((p) => `redacted (privacy): ${p}`);
      const rebuilt = joinDiff(split.preamble, kept);
      const rebuiltTokens = estimateTokens(rebuilt);
      // If the privacy-stripped diff already fits, return it as-is.
      // Otherwise fall through to the regular truncation tiers below,
      // operating on the stripped diff so redacted paths can never
      // re-enter via the working list.
      if (rebuiltTokens <= budgetTokens) {
        return {
          content: rebuilt,
          originalTokens,
          finalTokens: rebuiltTokens,
          truncated: true,
          droppedFiles: [...redactedPaths],
          redactedFiles: redactedPaths,
          notes,
        };
      }
      return truncateAfterRedaction({
        preamble: split.preamble,
        keptFiles: kept,
        originalTokens,
        budgetTokens,
        redactedFiles: redactedPaths,
        seedNotes: notes,
      });
    }
  }

  // Tier 0: fast path.
  if (originalTokens <= budgetTokens) {
    return {
      content: diff,
      originalTokens,
      finalTokens: originalTokens,
      truncated: false,
      droppedFiles: [],
      redactedFiles: [],
      notes: [],
    };
  }

  const { preamble, files } = splitDiff(diff);

  // Degenerate case: not enough structure to trim. Return as-is and let
  // the caller decide what to do.
  if (files.length === 0) {
    return {
      content: diff,
      originalTokens,
      finalTokens: originalTokens,
      truncated: false,
      droppedFiles: [],
      redactedFiles: [],
      notes: ['diff has no file boundaries; nothing to truncate'],
    };
  }

  return truncateAfterRedaction({
    preamble,
    keptFiles: files,
    originalTokens,
    budgetTokens,
    redactedFiles: [],
    seedNotes: [],
  });
}

/**
 * Run tiers 1-3 (noisy drop / stub bodies / drop whole files) on a
 * pre-split diff. Factored out so the privacy-redaction path can reuse
 * it after stripping out files that must never reach the AI.
 */
function truncateAfterRedaction(args: {
  preamble: string;
  keptFiles: DiffFile[];
  originalTokens: number;
  budgetTokens: number;
  redactedFiles: string[];
  seedNotes: string[];
}): TruncatedDiff {
  const { preamble, keptFiles, originalTokens, budgetTokens, redactedFiles } =
    args;
  const droppedFiles: string[] = [...redactedFiles];
  const notes: string[] = [...args.seedNotes];

  // Working list: we mutate this as we drop / stub files.
  // `raw` is what gets joined into the final diff.
  type WorkingFile = { path: string; raw: string; stubbed: boolean };
  let working: WorkingFile[] = keptFiles.map((f) => ({
    path: f.path,
    raw: f.raw,
    stubbed: false,
  }));

  const currentTokens = () => estimateTokens(joinDiff(preamble, working));

  // Tier 1: drop noisy files entirely.
  const noisy = working.filter((f) => isNoisyPath(f.path));
  if (noisy.length > 0) {
    working = working.filter((f) => !isNoisyPath(f.path));
    for (const f of noisy) {
      droppedFiles.push(f.path);
      notes.push(`dropped generated/lockfile: ${f.path}`);
    }
  }

  if (currentTokens() <= budgetTokens) {
    return finalize({
      preamble,
      working,
      originalTokens,
      droppedFiles,
      redactedFiles,
      notes,
    });
  }

  // Tier 2: stub the largest remaining files' bodies, largest first.
  // We recompute after each stub instead of pre-sorting and batching so
  // that we stop as soon as we're under budget.
  while (currentTokens() > budgetTokens) {
    const candidates = working.filter((f) => !f.stubbed);
    if (candidates.length === 0) break;
    // Pick the largest by raw byte length.
    candidates.sort((a, b) => b.raw.length - a.raw.length);
    const victim = candidates[0]!;
    victim.raw = stubFile({ path: victim.path, raw: victim.raw });
    victim.stubbed = true;
    if (!droppedFiles.includes(victim.path)) {
      droppedFiles.push(victim.path);
    }
    notes.push(`stubbed file body: ${victim.path}`);
  }

  if (currentTokens() <= budgetTokens) {
    return finalize({
      preamble,
      working,
      originalTokens,
      droppedFiles,
      redactedFiles,
      notes,
    });
  }

  // Tier 3: drop whole file entries (including their stub lines) until
  // we fit, smallest first so we keep the biggest signals.
  // Bodies are all stubbed at this point, so entries are tiny and
  // differences are mostly path length. Drop from the end (stable order).
  const dropped: WorkingFile[] = [];
  while (currentTokens() > budgetTokens && working.length > 0) {
    const victim = working.pop()!;
    dropped.push(victim);
  }
  if (dropped.length > 0) {
    notes.push(
      `dropped ${dropped.length} additional file${dropped.length === 1 ? '' : 's'} to fit budget`,
    );
  }

  // Append a footer listing the files we had to drop whole, so the model
  // knows there was more it isn't seeing.
  const footerLines: string[] = [];
  if (dropped.length > 0) {
    footerLines.push(`[… ${dropped.length} file(s) omitted to fit budget:`);
    for (const f of dropped) footerLines.push(`    ${f.path}`);
    footerLines.push(']');
  }

  const bodyWithFooter =
    joinDiff(preamble, working) +
    (footerLines.length > 0 ? `\n${footerLines.join('\n')}` : '');

  return {
    content: bodyWithFooter,
    originalTokens,
    finalTokens: estimateTokens(bodyWithFooter),
    truncated: true,
    droppedFiles,
    redactedFiles,
    notes,
  };
}

function finalize(args: {
  preamble: string;
  working: { raw: string }[];
  originalTokens: number;
  droppedFiles: string[];
  redactedFiles: string[];
  notes: string[];
}): TruncatedDiff {
  const content = joinDiff(args.preamble, args.working);
  return {
    content,
    originalTokens: args.originalTokens,
    finalTokens: estimateTokens(content),
    truncated: true,
    droppedFiles: args.droppedFiles,
    redactedFiles: args.redactedFiles,
    notes: args.notes,
  };
}
