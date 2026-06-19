/**
 * Turn bare `#123` references in release-notes text into Markdown links
 * pointing at the configured remote. Runs after both AI-generated and
 * template-generated notes so the output is consistent either way.
 *
 * Patterns matched (single global regex pass):
 *
 *     #123           → [#123](<webUrl>/pull/123)
 *     (#456)         → ([#456](...))
 *     Closes #789    → Closes [#789](...)   (any keyword — we only
 *                                             replace the #N portion)
 *
 * Skipped:
 *
 *     [#123](...)    — the `#` is preceded by `[`, so we leave it alone.
 *                      This means re-running the linker on already-
 *                      enriched text is a no-op.
 *     abc#123        — the `#` is preceded by a word character (mid-word
 *                      hash like a fragment or hash notation).
 *     `#123`         — inside an inline code span. These are usually
 *                      describing the syntax itself (e.g. "convert
 *                      `#123` into links") and should not be auto-linked.
 *                      A code span may be delimited by a run of any number
 *                      of backticks (CommonMark uses `` ``#1`` `` when the
 *                      content itself contains a backtick), and the closing
 *                      run must be the same length. The tokenizer consumes
 *                      the whole span in one shot so its contents are never
 *                      independently matched.
 *     ```…#123…```   — inside a triple-backtick fenced block. AI-generated
 *                      notes frequently include diffs or code samples where
 *                      a `#N` is a literal in the snippet, not a real PR
 *                      reference. The tokenizer consumes the whole fence.
 *
 * GitHub redirects `/issues/N` to `/pull/N` (and vice versa) for the
 * same number, so we link unconditionally to `/pull/N` without needing
 * to know whether `N` is a PR or an issue.
 *
 * If `remote` is null (no remote configured, or it failed to parse),
 * the text is returned unchanged.
 */
import type { RemoteInfo } from '../types.ts';

// Single-pass tokenizer with three alternatives:
//
//   1. ```…``` — a triple-backtick fenced code block (or inline triple
//                span). Non-greedy to a closing fence; an unclosed opener
//                falls through and is ignored.
//   2. `…`     — an inline code span delimited by a run of one or more
//                backticks (group 2 captures the opening run). The closing
//                run must be the same length (`\2` backreference); the body
//                spans no newlines and may contain shorter backtick runs.
//                The whole span is captured verbatim and skipped.
//   3. #N      — a bare PR/issue ref not preceded by a word char or `[`.
//                Captured and replaced with a markdown link.
//
// Alternatives are evaluated left-to-right at each position, so if a `#N`
// sits inside a code span or fenced block the span/fence is matched first
// and consumes it — the ref never gets a chance to match independently.
const TOKEN_REGEX =
  /(```[\s\S]*?```)|(`+)(?:[^`\n]|(?!\2)`)*?\2|(?<![\w[])#(\d+)\b/g;

export function enrichPrLinks(text: string, remote: RemoteInfo | null): string {
  if (remote === null || text.length === 0) return text;
  const base = `${remote.webUrl}/pull/`;
  return text.replace(
    TOKEN_REGEX,
    (
      match,
      fenced: string | undefined,
      ticks: string | undefined,
      num: string | undefined,
    ) => {
      if (fenced !== undefined) return fenced;
      // `ticks` (the opening backtick run) is defined iff the inline
      // code-span alternative matched — return the whole span verbatim.
      if (ticks !== undefined) return match;
      return `[#${num!}](${base}${num!})`;
    },
  );
}
