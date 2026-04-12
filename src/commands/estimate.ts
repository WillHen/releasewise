/**
 * `releasewise estimate` command.
 *
 * Shorthand for `releasewise release --estimate`. Prints the token/cost
 * estimate for the current diff without calling AI.
 */
import { defineCommand } from 'citty';

import { runRelease } from './release.ts';

export const estimateCommand = defineCommand({
  meta: {
    name: 'estimate',
    description: 'Print AI token + cost estimate for the current diff.',
  },
  args: {
    from: {
      type: 'string',
      description: 'Base ref for commit range (default: last tag)',
    },
    json: {
      type: 'boolean',
      description: 'Structured JSON output',
      default: false,
    },
  },
  async run({ args }) {
    const result = await runRelease({
      estimate: true,
      from: args.from as string | undefined,
      json: Boolean(args.json),
      noAi: true,
    });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
