import { describe, expect, it } from 'bun:test';

import pkg from '../package.json' with { type: 'json' };
import { resolveVersion } from '../src/cli-meta.ts';

describe('resolveVersion', () => {
  it('reads the current package.json version at runtime', () => {
    // This would regress if `src/index.ts` reverted to a build-time
    // import — a stale bundle would still report the old version even
    // after `package.json` was bumped on disk.
    expect(resolveVersion()).toBe(pkg.version);
  });
});
