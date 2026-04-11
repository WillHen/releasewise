/**
 * Parse a git remote URL into a canonical `{ host, owner, repo, webUrl }`
 * shape. Used by the PR linker (Step 8) to build `/pull/N` URLs and by
 * GitHub Releases integration (Step 14) to target the right repo via `gh`.
 *
 * Supported forms (all resolve to the same output shape):
 *
 *   - git@github.com:acme/widgets.git        (SCP-style SSH)
 *   - git@github.com:acme/widgets            (SCP-style SSH, no .git)
 *   - ssh://git@github.com/acme/widgets.git  (SSH with scheme)
 *   - https://github.com/acme/widgets.git    (HTTPS)
 *   - https://github.com/acme/widgets        (HTTPS, no .git)
 *   - https://github.com/acme/widgets/       (HTTPS with trailing slash)
 *
 * GitHub Enterprise is the same — only the host differs.
 *
 * Returns `null` for inputs we can't confidently parse (empty strings,
 * file:// URLs, nonsense). Callers should degrade gracefully — the most
 * common fallback is to skip PR link enrichment and proceed with plain
 * release notes.
 */
import type { RemoteInfo } from '../types.ts';

// SCP form: [user@]host:path  (user is usually `git`)
// Capture groups: 1 = host, 2 = owner, 3 = repo (possibly with .git suffix and trailing slash)
const SCP_REGEX = /^[^@\s]+@([^:\s]+):([^/\s]+)\/(.+?)\/?$/;

// Scheme-based URLs we're willing to parse with `new URL()`.
const URL_SCHEME_REGEX = /^(https?|ssh|git):\/\//;

export function parseRemoteUrl(url: string): RemoteInfo | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  // SCP form first — `git@host:path` is not a valid URL, so we have to
  // match it before trying `new URL()`.
  const scpMatch = SCP_REGEX.exec(trimmed);
  if (scpMatch) {
    const [, host, owner, repoRaw] = scpMatch;
    return build(host!, owner!, stripDotGit(repoRaw!));
  }

  if (URL_SCHEME_REGEX.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const segments = parsed.pathname.split('/').filter((p) => p.length > 0);
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    // For GitHub/GHE we expect exactly 2 segments. Grab the first as
    // owner and join the rest as repo — this handles most shapes and
    // errs on the side of "return something" rather than null.
    const repo = stripDotGit(segments.slice(1).join('/'));
    return build(parsed.host, owner, repo);
  }

  return null;
}

function stripDotGit(s: string): string {
  return s.endsWith('.git') ? s.slice(0, -4) : s;
}

function build(host: string, owner: string, repo: string): RemoteInfo | null {
  if (host.length === 0 || owner.length === 0 || repo.length === 0) {
    return null;
  }
  return {
    host,
    owner,
    repo,
    webUrl: `https://${host}/${owner}/${repo}`,
  };
}
