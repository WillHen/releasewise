#!/usr/bin/env bun
/**
 * releasewise — CLI entry point.
 *
 * Commands are registered lazily; each subcommand lives in `src/commands/`.
 */
import { defineCommand, runMain } from 'citty';

import { initCommand } from './commands/init.ts';
import { releaseCommand } from './commands/release.ts';
import { undoCommand } from './commands/undo.ts';
import { estimateCommand } from './commands/estimate.ts';
import { doctorCommand } from './commands/doctor.ts';

import pkg from '../package.json' with { type: 'json' };

const main = defineCommand({
  meta: {
    name: 'releasewise',
    version: pkg.version,
    description:
      'AI-powered CLI that turns a git diff into a high-quality release.',
  },
  subCommands: {
    init: initCommand,
    release: releaseCommand,
    undo: undoCommand,
    estimate: estimateCommand,
    doctor: doctorCommand,
  },
});

void runMain(main);
