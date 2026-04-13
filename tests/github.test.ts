import { describe, expect, it } from 'bun:test';

import {
  createGithubRelease,
  type CreateGithubReleaseOptions,
  type GithubReleaseDeps,
} from '../src/core/github.ts';
import type { RemoteInfo } from '../src/types.ts';

// --------- Helpers ---------

const remote: RemoteInfo = {
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
};

function baseOpts(
  overrides?: Partial<CreateGithubReleaseOptions>,
): CreateGithubReleaseOptions {
  return {
    tagName: 'v1.2.3',
    title: 'v1.2.3',
    body: '### Added\n\n- Cool feature',
    remote,
    cwd: '/fake',
    env: {},
    ...overrides,
  };
}

// --------- gh CLI strategy ---------

describe('createGithubRelease — gh CLI', () => {
  it('creates a release via gh when available', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => true,
      ghCreateRelease: async () => ({
        url: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
      }),
    };

    const result = await createGithubRelease(baseOpts(), deps);

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.method).toBe('gh');
      expect(result.url).toContain('v1.2.3');
    }
  });

  it('falls through to API when gh fails', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => true,
      ghCreateRelease: async () => {
        throw new Error('gh failed');
      },
      apiCreateRelease: async () => ({
        id: 42,
        url: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
      }),
    };

    const opts = baseOpts({ env: { GITHUB_TOKEN: 'ghp_test123' } });
    const result = await createGithubRelease(opts, deps);

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.method).toBe('api');
      expect(result.releaseId).toBe('42');
    }
  });
});

// --------- REST API strategy ---------

describe('createGithubRelease — REST API', () => {
  it('uses GITHUB_TOKEN when gh is not available', async () => {
    let capturedToken: string | undefined;
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
      apiCreateRelease: async (opts) => {
        capturedToken = opts.token;
        return {
          id: 99,
          url: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
        };
      },
    };

    const opts = baseOpts({ env: { GITHUB_TOKEN: 'ghp_abc' } });
    const result = await createGithubRelease(opts, deps);

    expect(result.status).toBe('created');
    expect(capturedToken).toBe('ghp_abc');
    if (result.status === 'created') {
      expect(result.method).toBe('api');
    }
  });

  it('uses GH_TOKEN as fallback', async () => {
    let capturedToken: string | undefined;
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
      apiCreateRelease: async (opts) => {
        capturedToken = opts.token;
        return { id: 1, url: 'https://example.com' };
      },
    };

    const opts = baseOpts({ env: { GH_TOKEN: 'ghp_fallback' } });
    const result = await createGithubRelease(opts, deps);

    expect(result.status).toBe('created');
    expect(capturedToken).toBe('ghp_fallback');
  });

  it('prefers GITHUB_TOKEN over GH_TOKEN', async () => {
    let capturedToken: string | undefined;
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
      apiCreateRelease: async (opts) => {
        capturedToken = opts.token;
        return { id: 1, url: 'https://example.com' };
      },
    };

    const opts = baseOpts({
      env: { GITHUB_TOKEN: 'primary', GH_TOKEN: 'secondary' },
    });
    await createGithubRelease(opts, deps);
    expect(capturedToken).toBe('primary');
  });
});

// --------- Skipped ---------

describe('createGithubRelease — skipped', () => {
  it('returns skipped when neither gh nor token is available', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
    };

    const result = await createGithubRelease(baseOpts(), deps);

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('gh');
      expect(result.reason).toContain('GITHUB_TOKEN');
      expect(result.manualCommand).toContain('gh release create v1.2.3');
      expect(result.manualCommand).toContain('acme/widgets');
    }
  });

  it('returns failed (not skipped) when both gh and API fail', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => true,
      ghCreateRelease: async () => {
        throw new Error('gh broke');
      },
      apiCreateRelease: async () => {
        throw new Error('api broke');
      },
    };

    // Has a token so API is attempted, but it fails too.
    const opts = baseOpts({ env: { GITHUB_TOKEN: 'ghp_test' } });
    const result = await createGithubRelease(opts, deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      // Last attempt is the API one, so method should reflect that.
      expect(result.method).toBe('api');
      // But both errors should be present in the summary.
      expect(result.error).toContain('gh: gh broke');
      expect(result.error).toContain('api: api broke');
      expect(result.manualCommand).toContain('gh release create v1.2.3');
    }
  });

  it('returns failed when gh errors and no token is available', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => true,
      ghCreateRelease: async () => {
        throw new Error('gh permission denied');
      },
    };
    const result = await createGithubRelease(baseOpts({ env: {} }), deps);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.method).toBe('gh');
      expect(result.error).toContain('gh permission denied');
    }
  });

  it('returns failed when gh is not available and the API call errors', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
      apiCreateRelease: async () => {
        throw new Error('GitHub API returned 422: validation failed');
      },
    };
    const opts = baseOpts({ env: { GITHUB_TOKEN: 'ghp_live' } });
    const result = await createGithubRelease(opts, deps);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.method).toBe('api');
      expect(result.error).toContain('422');
    }
  });

  it('redacts the auth token from any error message', async () => {
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => false,
      apiCreateRelease: async () => {
        // Simulate an error message that accidentally echoes the token.
        throw new Error('401: Bad credentials for token ghp_supersecret');
      },
    };
    const opts = baseOpts({ env: { GITHUB_TOKEN: 'ghp_supersecret' } });
    const result = await createGithubRelease(opts, deps);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).not.toContain('ghp_supersecret');
      expect(result.error).toContain('***');
    }
  });

  it('passes tag, title, body, and remote to gh', async () => {
    let captured: CreateGithubReleaseOptions | undefined;
    const deps: GithubReleaseDeps = {
      isGhAvailable: async () => true,
      ghCreateRelease: async (opts) => {
        captured = opts;
        return { url: 'https://example.com' };
      },
    };

    const opts = baseOpts({ tagName: 'v2.0.0', title: 'Release v2.0.0' });
    await createGithubRelease(opts, deps);

    expect(captured).toBeDefined();
    expect(captured!.tagName).toBe('v2.0.0');
    expect(captured!.title).toBe('Release v2.0.0');
    expect(captured!.body).toContain('Cool feature');
    expect(captured!.remote.owner).toBe('acme');
  });
});
