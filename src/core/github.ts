/**
 * GitHub Release integration.
 *
 * Two strategies, tried in order:
 *
 *   1. **`gh` CLI** — if `gh` is installed and authenticated, shell out
 *      to `gh release create`. Simplest path, handles auth and 2FA.
 *
 *   2. **REST API** — if `gh` is not available, fall back to the GitHub
 *      REST API using `GITHUB_TOKEN` or `GH_TOKEN` from the environment.
 *
 * If neither is available, return a "skipped" result with the exact `gh`
 * command the user can run manually.
 *
 * All functions accept injectable dependencies so tests stay fast and
 * deterministic (no real `gh` calls, no network).
 */
import { $ } from 'bun';
import { z } from 'zod';

import { ErrorCodes, ReleaseError } from '../errors.ts';
import type { RemoteInfo } from '../types.ts';
import { assertSafeArg } from './git.ts';

const GithubReleaseResponseSchema = z.object({
  id: z.number(),
  html_url: z.string().url(),
});

// Matches any GitHub-issued token: classic PATs (ghp_), OAuth (gho_),
// user-to-server (ghu_), server-to-server (ghs_), refresh (ghr_), and
// fine-grained PATs (github_pat_). Anchored with \b to avoid chewing
// the middle of unrelated identifiers.
const GITHUB_TOKEN_PATTERN = /\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{8,}/g;

// --------- Public types ---------

export interface CreateGithubReleaseOptions {
  /** Tag name (e.g. "v1.2.3"). */
  tagName: string;
  /** Release title (usually same as tag name). */
  title: string;
  /** Markdown body for the release. */
  body: string;
  /** Parsed remote info (host, owner, repo). */
  remote: RemoteInfo;
  /** Working directory. */
  cwd: string;
  /** Environment variables (for GITHUB_TOKEN / GH_TOKEN lookup). */
  env?: Record<string, string | undefined>;
}

export type GithubReleaseResult =
  | { status: 'created'; releaseId: string; url: string; method: 'gh' | 'api' }
  | {
      status: 'failed';
      /** Which strategy's error is reflected in `error` (the last one tried). */
      method: 'gh' | 'api';
      /**
       * Summary of every strategy that was tried, with its error message.
       * Tokens are redacted and the total length is capped so the line
       * stays readable in the CLI summary.
       */
      error: string;
      manualCommand: string;
    }
  | { status: 'skipped'; reason: string; manualCommand: string };

export interface GithubReleaseDeps {
  /** Check if `gh` CLI is available and authenticated. */
  isGhAvailable?: (cwd: string) => Promise<boolean>;
  /** Create a release via `gh release create`. */
  ghCreateRelease?: (
    opts: CreateGithubReleaseOptions,
  ) => Promise<{ url: string }>;
  /** Create a release via the GitHub REST API. */
  apiCreateRelease?: (
    opts: CreateGithubReleaseOptions & { token: string },
  ) => Promise<{ id: number; url: string }>;
}

// --------- Main entry point ---------

export async function createGithubRelease(
  opts: CreateGithubReleaseOptions,
  deps: GithubReleaseDeps = {},
): Promise<GithubReleaseResult> {
  const isGhAvailable = deps.isGhAvailable ?? defaultIsGhAvailable;
  const ghCreate = deps.ghCreateRelease ?? defaultGhCreateRelease;
  const apiCreate = deps.apiCreateRelease ?? defaultApiCreateRelease;
  const env = opts.env ?? process.env;

  const manualCommand =
    `gh release create ${opts.tagName} ` +
    `--repo ${opts.remote.owner}/${opts.remote.repo} ` +
    `--title "${opts.title}" --notes "..."`;

  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const attempts: Array<{ method: 'gh' | 'api'; error: string }> = [];

  // Strategy 1: gh CLI.
  if (await isGhAvailable(opts.cwd)) {
    try {
      const result = await ghCreate(opts);
      // gh doesn't return a numeric ID easily, use the URL as identifier.
      return {
        status: 'created',
        releaseId: result.url,
        url: result.url,
        method: 'gh',
      };
    } catch (err) {
      attempts.push({ method: 'gh', error: summarizeError(err, token) });
      // Fall through to API strategy.
    }
  }

  // Strategy 2: REST API with token.
  if (token) {
    try {
      const result = await apiCreate({ ...opts, token });
      return {
        status: 'created',
        releaseId: String(result.id),
        url: result.url,
        method: 'api',
      };
    } catch (err) {
      attempts.push({ method: 'api', error: summarizeError(err, token) });
      // Fall through to failed/skipped.
    }
  }

  if (attempts.length > 0) {
    const last = attempts[attempts.length - 1]!;
    const combined = attempts.map((a) => `${a.method}: ${a.error}`).join('; ');
    return {
      status: 'failed',
      method: last.method,
      error: combined,
      manualCommand,
    };
  }

  // Nothing was tried — missing both gh and any token.
  return {
    status: 'skipped',
    reason:
      'Could not create GitHub Release: `gh` CLI not available and no ' +
      'GITHUB_TOKEN / GH_TOKEN found in environment.',
    manualCommand,
  };
}

/**
 * Turn a thrown error into a short, safe one-line summary for embedding
 * in a release result: strip the token if we know it, collapse
 * whitespace, and truncate to keep CLI output readable.
 */
function summarizeError(err: unknown, token: string | undefined): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Redact any GitHub-shaped token, even ones we didn't originate —
  // `gh` CLI often echoes tokens from the user's keychain.
  let redacted = raw.replace(GITHUB_TOKEN_PATTERN, '***');

  // Belt-and-braces: if we know the exact token, redact anything starting
  // with its first 8 chars so truncated or transformed copies can't slip
  // past the pattern above.
  if (token && token.length >= 12) {
    const prefix = token.slice(0, 8);
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(`${escaped}\\S*`, 'g'), '***');
  }

  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  const MAX = 500;
  return collapsed.length > MAX ? `${collapsed.slice(0, MAX)}…` : collapsed;
}

// --------- Default implementations ---------

async function defaultIsGhAvailable(cwd: string): Promise<boolean> {
  try {
    // `gh auth status` exits 0 if authenticated, non-zero otherwise.
    await $`gh auth status`.cwd(cwd).quiet();
    return true;
  } catch {
    return false;
  }
}

async function defaultGhCreateRelease(
  opts: CreateGithubReleaseOptions,
): Promise<{ url: string }> {
  assertSafeArg(opts.tagName, 'tagName');
  assertSafeArg(opts.remote.owner, 'remote.owner');
  assertSafeArg(opts.remote.repo, 'remote.repo');
  const repo = `${opts.remote.owner}/${opts.remote.repo}`;
  // Use `--flag=value` form so the title/body can never be parsed as a
  // flag even if they begin with '-'. Each interpolation is still one
  // argv entry (Bun `$`), so no shell escaping concerns.
  const result =
    await $`gh release create ${opts.tagName} --repo=${repo} --title=${opts.title} --notes=${opts.body}`
      .cwd(opts.cwd)
      .text();

  // `gh release create` prints the release URL on stdout.
  const url = result.trim();
  return { url: url || `${opts.remote.webUrl}/releases/tag/${opts.tagName}` };
}

async function defaultApiCreateRelease(
  opts: CreateGithubReleaseOptions & { token: string },
): Promise<{ id: number; url: string }> {
  const apiBase =
    opts.remote.host === 'github.com'
      ? 'https://api.github.com'
      : `https://${opts.remote.host}/api/v3`;

  const response = await fetch(
    `${apiBase}/repos/${opts.remote.owner}/${opts.remote.repo}/releases`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        tag_name: opts.tagName,
        name: opts.title,
        body: opts.body,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ReleaseError({
      code: ErrorCodes.GITHUB_RELEASE_FAILED,
      message: `GitHub API returned ${response.status}: ${text.slice(0, 200)}`,
      hint: hintForGithubStatus(response.status),
      details: { status: response.status },
    });
  }

  const raw: unknown = await response.json();
  const parsed = GithubReleaseResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseError({
      code: ErrorCodes.GITHUB_RELEASE_FAILED,
      message: `GitHub API returned an unexpected response shape: ${parsed.error.message}`,
      hint: 'Re-run the printed `gh release create ...` command manually to complete the release.',
    });
  }
  return { id: parsed.data.id, url: parsed.data.html_url };
}

function hintForGithubStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'Check that GITHUB_TOKEN/GH_TOKEN has `repo` + `contents:write` scopes for this repo.';
  }
  if (status === 404) {
    return 'Repo not found — confirm the `origin` remote points at a repo the token can access.';
  }
  if (status === 422) {
    return 'A release for this tag may already exist. Delete it on GitHub, or bump to a new version.';
  }
  if (status === 429 || status === 503) {
    return 'Hit a rate limit — wait a minute and retry. `--no-github-release` skips this step.';
  }
  return 'Re-run the printed `gh release create ...` command manually to complete the release.';
}
