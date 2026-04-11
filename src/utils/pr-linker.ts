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
 *
 * GitHub redirects `/issues/N` to `/pull/N` (and vice versa) for the
 * same number, so we link unconditionally to `/pull/N` without needing
 * to know whether `N` is a PR or an issue.
 *
 * If `remote` is null (no remote configured, or it failed to parse),
 * the text is returned unchanged.
 */
import type { RemoteInfo } from '../types.ts';

// Negative lookbehind to skip already-linked refs and mid-word hashes.
// - `\w` — word chars (letters, digits, underscore)
// - `[`  — opening bracket of an existing markdown link
// Requires at least one digit after the `#`, with a word boundary after.
const REF_REGEX = /(?<![\w[])#(\d+)\b/g;

export function enrichPrLinks(text: string, remote: RemoteInfo | null): string {
  if (remote === null || text.length === 0) return text;
  const base = `${remote.webUrl}/pull/`;
  return text.replace(REF_REGEX, (_match, n: string) => `[#${n}](${base}${n})`);
}
