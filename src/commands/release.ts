import { defineCommand } from 'citty';

export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description: 'Analyze commits, bump version, write notes, tag and push.',
  },
  args: {
    bump: {
      type: 'string',
      description: 'Force bump type: major | minor | patch',
    },
    mode: {
      type: 'string',
      description: 'Commit analysis mode: conventional | mixed | manual',
    },
    pre: {
      type: 'string',
      description: 'Pre-release label (e.g. beta, rc) → 1.0.0-beta.0',
    },
    from: {
      type: 'string',
      description: 'Base ref for commit range (default: last tag)',
    },
    tone: {
      type: 'string',
      description: 'formal | casual | technical',
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip all prompts',
      default: false,
    },
    'no-push': {
      type: 'boolean',
      description: 'Do not run git push',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Run AI + preview but make no changes',
      default: false,
    },
    estimate: {
      type: 'boolean',
      description: 'Print token/cost estimate and exit',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Structured JSON output',
      default: false,
    },
    'no-ai': {
      type: 'boolean',
      description: 'Skip AI, use template fallback',
      default: false,
    },
    'no-github-release': {
      type: 'boolean',
      description: 'Skip GitHub Release creation',
      default: false,
    },
    credits: {
      type: 'boolean',
      description: 'Append contributor attribution to notes',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress step logs',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Verbose logging',
      default: false,
    },
  },
  async run() {
    console.log('releasewise release — not yet implemented (step 12)');
  },
});
