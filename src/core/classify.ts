/**
 * Commit classification — two modes:
 *
 *   1. **Conventional.** Every commit is parsed with
 *      `parseConventionalCommit`. Unknown commits contribute `none` to
 *      the bump (they're effectively ignored). No AI call.
 *
 *   2. **Mixed.** Conventional parse first; commits that come back as
 *      `none` are batched into a single AI call that classifies each as
 *      `major|minor|patch|skip` with a one-line rationale. The AI
 *      output is merged back and the final bump is the max across all
 *      commits.
 *
 * The `manual` mode from the plan is cut from v1 — users who want to
 * override the bump pass `--bump <type>` instead. This module's input
 * type is narrowed to `'conventional' | 'mixed'` so the orchestrator
 * handles manual separately (or not at all in v1).
 *
 * Error handling: if the provider call throws or the response can't be
 * parsed, every unknown commit is assigned `patch` with a rationale
 * explaining the fallback. Swallowing errors this way is deliberate —
 * classification failures should degrade the release quality, not
 * block the release entirely. The orchestrator decides whether to
 * surface the warning.
 */
import type {
  AIProvider,
  BumpType,
  ClassifiedCommit,
  Commit,
} from '../types.ts';
import { maxBump, parseConventionalCommit } from './commits.ts';

// --------- Public types ---------

export interface ClassifyOptions {
  commits: Commit[];
  /**
   * Classification mode. `manual` is intentionally excluded — use
   * `--bump <type>` at the CLI level if you need a forced bump.
   */
  mode: 'conventional' | 'mixed';
  /**
   * AI provider for mixed mode. If null, mixed mode degrades to
   * conventional-only (unknown commits stay at `none`). Unused in
   * conventional mode.
   */
  provider?: AIProvider | null;
  /** Max tokens for the classifier AI call. */
  maxOutputTokens?: number;
  /** Temperature for the classifier AI call. */
  temperature?: number;
}

export interface ClassifyResult {
  /** Every input commit, in input order, with bump + source attached. */
  commits: ClassifiedCommit[];
  /** The aggregated bump across all classified commits. */
  bump: BumpType;
}

// --------- System prompt ---------

export const CLASSIFIER_SYSTEM_PROMPT = `You are a commit classifier for semver bump detection.

You are given a list of commits that could not be parsed as Conventional Commits. For each one, decide what semver bump it should contribute based on its subject and body.

Bump levels:
- "major" — a breaking change that will require users to update their code, config, or dependencies.
- "minor" — a new user-visible feature that is not breaking.
- "patch" — a bug fix, performance improvement, or non-breaking internal change that still affects behavior.
- "skip" — purely internal with no user impact (tests, CI, tooling, formatting, non-behavioral refactors, docs-only).

Output rules:
- Return a strict JSON array. One object per input commit, in the same order.
- Each object has exactly these keys: "sha" (the short SHA from the input), "bump" (one of the four levels above), "rationale" (a short sentence explaining the choice, under 120 characters).
- Output the JSON array only, nothing before or after. No prose, no markdown code fences, no preamble.
- If you genuinely cannot tell, pick "patch" and say so in the rationale — never omit a commit from the array.`;

// --------- User prompt ---------

/**
 * Build the user prompt for the classifier. Each commit is rendered as
 * its shortSha + subject, with body lines indented underneath for
 * context. The shortSha is the matching key used to merge the AI
 * response back onto our classified list.
 */
export function buildClassifierUserPrompt(commits: Commit[]): string {
  const lines: string[] = [];
  lines.push(`Classify the following ${commits.length} commit(s):`);
  lines.push('');
  for (const c of commits) {
    lines.push(`- ${c.shortSha}: ${c.subject}`);
    if (c.body.length > 0) {
      for (const bl of c.body.split('\n')) lines.push(`    ${bl}`);
    }
  }
  lines.push('');
  lines.push(
    'Return a JSON array with one entry per commit, keyed by the short SHA.',
  );
  return lines.join('\n');
}

// --------- Response parsing ---------

interface RawClassification {
  sha: string;
  bump: BumpType | 'skip';
  rationale: string;
}

/**
 * Parse a classifier response into structured entries.
 *
 * Handles the common shapes models tend to return:
 *   - Bare JSON array
 *   - JSON wrapped in a ```/```json fence
 *   - JSON embedded in prose (we extract from the first `[` to the last `]`)
 *
 * Throws if the result isn't a valid array of the expected shape.
 */
export function parseClassifierResponse(text: string): RawClassification[] {
  let trimmed = text.trim();

  // Strip a surrounding ``` / ```json fence if present.
  const fenceMatch = /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  if (fenceMatch) trimmed = fenceMatch[1]!.trim();

  // If the text still doesn't start with `[`, pull out the first balanced
  // array-ish block. This is a best-effort extraction — we're not trying
  // to handle pathological nested prose, just the common "here's your
  // JSON: [...]" case.
  if (!trimmed.startsWith('[')) {
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (
      firstBracket === -1 ||
      lastBracket === -1 ||
      lastBracket < firstBracket
    ) {
      throw new Error('Classifier response did not contain a JSON array');
    }
    trimmed = trimmed.slice(firstBracket, lastBracket + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Classifier response was not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Classifier response was not a JSON array');
  }

  const out: RawClassification[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('Classifier entry was not an object');
    }
    const e = entry as Record<string, unknown>;
    const sha = e.sha;
    const bump = e.bump;
    const rationale = e.rationale;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error('Classifier entry missing sha');
    }
    if (
      bump !== 'major' &&
      bump !== 'minor' &&
      bump !== 'patch' &&
      bump !== 'skip'
    ) {
      throw new Error(`Classifier entry has invalid bump: ${String(bump)}`);
    }
    out.push({
      sha,
      bump,
      rationale: typeof rationale === 'string' ? rationale : '',
    });
  }
  return out;
}

// --------- Main entry point ---------

export async function classifyCommits(
  opts: ClassifyOptions,
): Promise<ClassifyResult> {
  // Pass 1: conventional parser on every commit.
  const initial: ClassifiedCommit[] = opts.commits.map((c) => ({
    ...c,
    bump: parseConventionalCommit(c),
    source: 'conventional' as const,
  }));

  // Conventional mode, no unknowns, or no provider → we're done after pass 1.
  const hasUnknowns = initial.some((c) => c.bump === 'none');
  if (opts.mode === 'conventional' || !hasUnknowns || !opts.provider) {
    return {
      commits: initial,
      bump: aggregateBump(initial),
    };
  }

  // Pass 2: mixed mode — send unknowns to the AI in one batch.
  const unknowns = initial.filter((c) => c.bump === 'none');
  const merged = await mergeAiClassification(
    initial,
    unknowns,
    opts.provider,
    opts,
  );

  return {
    commits: merged,
    bump: aggregateBump(merged),
  };
}

// --------- Helpers ---------

function aggregateBump(commits: ClassifiedCommit[]): BumpType {
  let acc: BumpType = 'none';
  for (const c of commits) {
    acc = maxBump(acc, c.bump);
    if (acc === 'major') return acc;
  }
  return acc;
}

async function mergeAiClassification(
  initial: ClassifiedCommit[],
  unknowns: ClassifiedCommit[],
  provider: AIProvider,
  opts: ClassifyOptions,
): Promise<ClassifiedCommit[]> {
  let entries: RawClassification[];
  let fallbackRationale: string | null = null;

  try {
    const result = await provider.generate({
      system: CLASSIFIER_SYSTEM_PROMPT,
      user: buildClassifierUserPrompt(unknowns),
      maxTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
    });
    entries = parseClassifierResponse(result.text);
  } catch (err) {
    entries = [];
    fallbackRationale = `AI classification failed (${
      (err as Error).message || 'unknown error'
    }); treated as patch`;
  }

  // Index by shortSha for O(1) merge.
  const byShortSha = new Map<string, RawClassification>();
  for (const e of entries) byShortSha.set(e.sha, e);

  return initial.map((c) => {
    if (c.bump !== 'none') return c;
    const hit = byShortSha.get(c.shortSha);
    if (!hit) {
      return {
        ...c,
        bump: 'patch',
        source: 'ai',
        rationale:
          fallbackRationale ??
          'AI did not return a classification; treated as patch',
      };
    }
    // `skip` → none contribution to the bump.
    const bump: BumpType = hit.bump === 'skip' ? 'none' : hit.bump;
    return {
      ...c,
      bump,
      source: 'ai',
      rationale: hit.rationale,
    };
  });
}
