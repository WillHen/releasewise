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

import type { RemoteInfo } from '../types.ts';
import { assertSafeArg } from './git.ts';

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
    } catch {
      // Fall through to API strategy.
    }
  }

  // Strategy 2: REST API with token.
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) {
    try {
      const result = await apiCreate({ ...opts, token });
      return {
        status: 'created',
        releaseId: String(result.id),
        url: result.url,
        method: 'api',
      };
    } catch {
      // Fall through to skipped.
    }
  }

  // Neither worked — tell the user what to do.
  return {
    status: 'skipped',
    reason:
      'Could not create GitHub Release: `gh` CLI not available and no ' +
      'GITHUB_TOKEN / GH_TOKEN found in environment.',
    manualCommand,
  };
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
    throw new Error(
      `GitHub API returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as { id: number; html_url: string };
  return { id: data.id, url: data.html_url };
}
