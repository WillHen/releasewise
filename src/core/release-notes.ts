/**
 * Release-notes generation.
 *
 * Two paths, same shape of output:
 *
 *   1. **AI path.** Build a user prompt from commits + truncated diff,
 *      send it to an `AIProvider`, parse the response into a Keep a
 *      Changelog-shaped markdown body, enrich PR/issue references,
 *      wrap in a `ReleaseNotes` object.
 *
 *   2. **Template path.** (`provider === null`, or AI returned empty
 *      after parsing.) Deterministic fallback: classify commits by
 *      conventional type into Keep a Changelog sections. No AI call.
 *
 * PR link enrichment runs in both paths, so the output format is
 * consistent regardless of how the body was generated.
 */
import type { AIProvider, Commit, ReleaseNotes, RemoteInfo } from '../types.ts';
import { enrichPrLinks } from '../utils/pr-linker.ts';

// --------- System prompt ---------

/**
 * System prompt for the AI path. Stable and deliberately opinionated:
 * every constraint here is one we want enforced every time. Iterating
 * on this prompt is expected once we dogfood on real commit histories.
 */
export const SYSTEM_PROMPT = `You are a release-notes writer for a command-line or library package. Given a list of commits and a truncated diff between two versions, produce a Markdown release-notes body for the new version.

## The bullet shape rule (THE most important rule)

Every bullet MUST describe exactly one of these five things. If a bullet does not fit one of these shapes, DELETE IT. There is no sixth category.

  1. A command, subcommand, or CLI flag a user can now run.
  2. A new behavior of an existing command that a user already invokes.
  3. A new user-facing configuration option (env var, config file field).
  4. A new file the user directly reads, writes, or ships (e.g. an auto-generated \`CHANGELOG.md\`).
  5. A user-reportable bug that was fixed — must go in ### Fixed and describe the symptom, not the code.

If a commit is about internal modules, classes, parsers, classifiers, resolvers, orchestrators, factories, adapters, wrappers, schemas, test suites, test coverage, CI workflows, lint/format tooling, build scripts, docs-only edits, internal refactors, type-system changes, or dependency bumps that do not change user behavior — DO NOT write a bullet for it. Omit it. These categories are ALWAYS internal regardless of how much code they represent.

Most first releases of a CLI tool have 1-5 real user-facing bullets even when the diff contains dozens or hundreds of commits. If you find yourself writing more than 10 bullets, you are almost certainly describing implementation — go back and collapse or delete.

## Output rules

- Use Keep a Changelog section headings, in this exact order, omitting empty ones: ### Added, ### Changed, ### Deprecated, ### Removed, ### Fixed, ### Security.
- Each entry is a single bullet, sentence case, no trailing period.
- Every bullet MUST be traceable to at least one commit in the provided list. Do not invent, extrapolate, or embellish.
- If several commits together compose one user-facing capability, write ONE bullet for that capability, not one per commit.
- On a first release (when the user prompt says "Previous version: (none — first release)"), use ONLY the ### Added section. No Changed, Deprecated, Removed, Fixed, or Security — there is no prior behavior to change or fix from.
- Avoid filler and puffery: no "various improvements", "under the hood", "comprehensive", "robust", "significantly improved", "seamless".
- Preserve "#123" style issue/PR references from commit messages verbatim. The tool links them afterwards. Do NOT wrap them in backticks or markdown link syntax yourself.
- Do not include a version heading or preamble — the tool adds those. Output the section headings and bullets only, nothing else.

## Examples

GOOD example — a hypothetical first release of a \`foo\` CLI, built from 50+ internal commits, where only five bullets are user-facing:

  ### Added

  - \`foo release\` command that analyzes commits, picks a semver bump, writes a changelog entry, and tags the release
  - \`foo release --dry-run\` flag to preview everything without touching git or the filesystem
  - \`.foorc.json\` project configuration, with sensitive values loaded from env vars or a gitignored \`.foorc.local.json\`
  - Automatic semver bump detection from Conventional Commits, including \`feat!:\` and \`BREAKING CHANGE:\` for major bumps
  - AI-generated release notes via Anthropic, with an offline template fallback when the AI is disabled

Every one of those bullets maps to something a user types, reads, or configures. Nothing is named after an internal module.

BAD bullets that would be REJECTED:

  - "Git remote URL parser supporting SSH and HTTPS" — internal module; not a command, flag, or config. Omit.
  - "Conventional commit parser with bang syntax support" — internal; describe the user-visible effect ("automatic bump detection from Conventional Commits") instead.
  - "Comprehensive test suite covering git operations" — tests are ALWAYS internal; omit entirely.
  - "ESLint 9 with TypeScript support and consistent-type-imports" — lint tooling is ALWAYS internal; omit entirely.
  - "GitHub Actions CI workflow running lint and tests" — CI is ALWAYS internal; omit entirely.
  - "Release planning orchestrator that collects git and filesystem inputs" — user sees a command, not an orchestrator.
  - "AI provider factory with Anthropic adapter and retry wrapper" — three internal nouns; the user only sees "AI-generated release notes via Anthropic".`;

// --------- User prompt ---------

export interface UserPromptOptions {
  newVersion: string;
  previousVersion: string | null;
  commits: Commit[];
  diff: string;
  diffDroppedFiles: string[];
}

export function buildUserPrompt(opts: UserPromptOptions): string {
  const { newVersion, previousVersion, commits, diff, diffDroppedFiles } = opts;
  const lines: string[] = [];
  lines.push(`New version: ${newVersion}`);
  lines.push(
    `Previous version: ${previousVersion ?? '(none — first release)'}`,
  );
  if (previousVersion === null) {
    lines.push('');
    lines.push(
      'NOTE: This is a first release. Use ONLY the ### Added section. ' +
        'Do not produce Changed, Deprecated, Removed, Fixed, or Security — ' +
        'there is no prior version to change or fix from.',
    );
  }
  lines.push('');
  lines.push(`Commits (${commits.length} total, newest first):`);
  if (commits.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of commits) {
      lines.push(`- ${c.shortSha} ${c.subject}`);
      if (c.body.length > 0) {
        for (const bl of c.body.split('\n')) lines.push(`    ${bl}`);
      }
    }
  }
  lines.push('');
  if (diffDroppedFiles.length > 0) {
    lines.push('(Some files were omitted from the diff below to fit budget:');
    for (const f of diffDroppedFiles) lines.push(`    ${f}`);
    lines.push(')');
    lines.push('');
  }
  lines.push('Changes (diff):');
  lines.push(diff.length > 0 ? diff : '(empty diff)');
  return lines.join('\n');
}

// --------- Template fallback ---------

const CHANGELOG_SECTIONS = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;
type Section = (typeof CHANGELOG_SECTIONS)[number];

// These regexes duplicate commits.ts on purpose — here we're classifying
// for *presentation*, not bump detection, and the two concerns diverge
// (e.g. `docs` → Changed here but → patch in bump).
const FEAT_REGEX = /^(feat|feature)(\(.+\))?!?:/i;
const FIX_REGEX = /^fix(\(.+\))?!?:/i;
const CHANGED_REGEX = /^(perf|refactor|docs)(\(.+\))?!?:/i;
const BANG_REGEX = /^\w+(\(.+\))?!:/i;
const BREAKING_FOOTER_REGEX = /BREAKING[\s-]CHANGE:/i;

/**
 * Classify a commit into a Keep a Changelog section, or return `null`
 * to omit it (chore/ci/build/test/style/unknown).
 *
 * Breaking changes land in `Changed` — the template can't reliably
 * distinguish "change that broke callers" from "feature removal"
 * without a human or AI in the loop, and `Changed` is the safer
 * catch-all.
 */
function classifyForTemplate(commit: Commit): Section | null {
  const subject = commit.subject.trim();
  const body = commit.body;
  if (BANG_REGEX.test(subject) || BREAKING_FOOTER_REGEX.test(body)) {
    return 'Changed';
  }
  if (FEAT_REGEX.test(subject)) return 'Added';
  if (FIX_REGEX.test(subject)) return 'Fixed';
  if (CHANGED_REGEX.test(subject)) return 'Changed';
  return null;
}

/** Strip a `type(scope)!:` prefix from a commit subject. */
function stripConventionalPrefix(subject: string): string {
  const m = /^\w+(\([^)]*\))?!?:\s*/.exec(subject);
  return m ? subject.slice(m[0].length) : subject;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatBullet(commit: Commit): string {
  const cleaned = capitalize(
    stripConventionalPrefix(commit.subject.trim()),
  ).replace(/\.+$/, '');
  return `- ${cleaned} (${commit.shortSha})`;
}

export function buildTemplateBody(commits: Commit[]): string {
  const buckets: Record<Section, string[]> = {
    Added: [],
    Changed: [],
    Deprecated: [],
    Removed: [],
    Fixed: [],
    Security: [],
  };
  for (const c of commits) {
    const section = classifyForTemplate(c);
    if (section === null) continue;
    buckets[section].push(formatBullet(c));
  }
  const lines: string[] = [];
  for (const section of CHANGELOG_SECTIONS) {
    if (buckets[section].length === 0) continue;
    lines.push(`### ${section}`);
    for (const b of buckets[section]) lines.push(b);
    lines.push('');
  }
  const body = lines.join('\n').trim();
  return body.length > 0 ? body : '_No user-facing changes in this release._';
}

// --------- AI response parsing ---------

/**
 * Clean up an AI-generated body:
 *
 *   - Trim whitespace.
 *   - Strip leading `#` or `##` headings — some models add a version
 *     heading despite the instructions. We preserve `###` and deeper
 *     since those are our legitimate section headings.
 *   - Strip a surrounding ```/```markdown fence if the model wrapped
 *     its whole output in one.
 */
export function parseAIBody(text: string): string {
  let result = text.trim();

  // Strip a single surrounding fence. Handles ```…``` and ```markdown…```.
  const fenceMatch = /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```\s*$/.exec(result);
  if (fenceMatch) result = fenceMatch[1]!.trim();

  // Strip leading `#` / `##` heading lines (but not `###` sections).
  while (/^#{1,2}\s/.test(result)) {
    const nl = result.indexOf('\n');
    if (nl === -1) {
      result = '';
      break;
    }
    result = result.slice(nl + 1).trim();
  }

  return result;
}

// --------- Heading + wrapping ---------

export function formatHeading(version: string, date: string): string {
  return `## [${version}] - ${date}`;
}

export function buildReleaseNotes(
  body: string,
  version: string,
  date: string,
): ReleaseNotes {
  return {
    title: `v${version}`,
    heading: formatHeading(version, date),
    body,
  };
}

// --------- Orchestrator ---------

export interface GenerateReleaseNotesOptions {
  /** Commits in the release, newest first. */
  commits: Commit[];
  /** Pre-truncated diff body (from diff-truncator). */
  diff: string;
  /** Files the truncator had to drop — passed to the AI for context. */
  diffDroppedFiles: string[];
  /** Target version, e.g. "1.2.3". */
  version: string;
  /** Previous version, or null for the first release. */
  previousVersion: string | null;
  /** ISO date string, e.g. "2026-04-11". */
  date: string;
  /**
   * AI provider to use, or `null` for the deterministic template path
   * (the `--no-ai` case, and the fallback if AI returns empty).
   */
  provider: AIProvider | null;
  /** Parsed remote for PR link enrichment. Null → skip enrichment. */
  remote: RemoteInfo | null;
  /** Max output tokens for the AI call (from config.ai.maxOutputTokens). */
  maxOutputTokens?: number;
  /** Temperature for the AI call (from config.ai.temperature). */
  temperature?: number;
}

export async function generateReleaseNotes(
  opts: GenerateReleaseNotesOptions,
): Promise<ReleaseNotes> {
  const body = opts.provider
    ? await generateAIBodyWithFallback(opts, opts.provider)
    : buildTemplateBody(opts.commits);

  const enriched = enrichPrLinks(body, opts.remote);
  return buildReleaseNotes(enriched, opts.version, opts.date);
}

async function generateAIBodyWithFallback(
  opts: GenerateReleaseNotesOptions,
  provider: AIProvider,
): Promise<string> {
  const userPrompt = buildUserPrompt({
    newVersion: opts.version,
    previousVersion: opts.previousVersion,
    commits: opts.commits,
    diff: opts.diff,
    diffDroppedFiles: opts.diffDroppedFiles,
  });
  const result = await provider.generate({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  });
  const parsed = parseAIBody(result.text);
  // Safety net: if the AI returns nothing useful, use the template so
  // the release still has a body instead of an empty section.
  return parsed.length > 0 ? parsed : buildTemplateBody(opts.commits);
}
