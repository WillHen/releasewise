/**
 * `releasewise undo` command.
 *
 * Reads the transaction log at `.releasewise/last-release.json` and
 * reverses the release: deletes the local tag and resets the bump
 * commit. Refuses if the release was already pushed.
 *
 * Like `release.ts`, the testable core is `runUndo()` and the citty
 * wrapper is `undoCommand`.
 */
import { defineCommand } from 'citty';

import {
  deleteTag as realDeleteTag,
  isClean as realIsClean,
  resetHard as realResetHard,
  resolveRef as realResolveRef,
} from '../core/git.ts';
import {
  readTransactionLog as realReadTransactionLog,
  transactionLogPath,
} from '../core/rollback.ts';
import { formatError } from '../errors.ts';
import type { TransactionLog } from '../types.ts';

// --------- Public shape ---------

export interface RunUndoDeps {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  verbose?: boolean;
  readTransactionLog?: (cwd: string) => Promise<TransactionLog | null>;
  isClean?: (opts: { cwd: string }) => Promise<boolean>;
  deleteTag?: (name: string, opts: { cwd: string }) => Promise<void>;
  resetHard?: (ref: string, opts: { cwd: string }) => Promise<void>;
  resolveRef?: (ref: string, opts: { cwd: string }) => Promise<string | null>;
}

export interface RunUndoResult {
  exitCode: number;
}

// --------- runUndo ---------

export async function runUndo(deps: RunUndoDeps = {}): Promise<RunUndoResult> {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(t));
  const cwd = deps.cwd ?? process.cwd();
  const readLog = deps.readTransactionLog ?? realReadTransactionLog;
  const isClean = deps.isClean ?? realIsClean;
  const deleteTag = deps.deleteTag ?? realDeleteTag;
  const resetHard = deps.resetHard ?? realResetHard;
  const resolveRef = deps.resolveRef ?? realResolveRef;

  try {
    // 1. Read the transaction log.
    const log = await readLog(cwd);
    if (!log) {
      stderr(
        `Error: no transaction log found at ${transactionLogPath(cwd)}\n` +
          `Nothing to undo. Run \`releasewise release\` first.\n`,
      );
      return { exitCode: 1 };
    }

    // 2. Refuse if already pushed.
    if (log.pushed) {
      stderr(
        `Error: release ${log.tagName ?? log.toVersion} was already pushed.\n` +
          `Automatic undo is not safe after push. To roll back manually:\n\n` +
          `  git tag -d ${log.tagName}\n` +
          `  git push origin :refs/tags/${log.tagName}\n` +
          `  git revert ${log.bumpCommitSha?.slice(0, 7) ?? 'HEAD'}\n` +
          `  git push\n`,
      );
      return { exitCode: 1 };
    }

    // 3. Refuse if the working tree is dirty.
    if (!(await isClean({ cwd }))) {
      stderr(
        'Error: working tree has uncommitted changes.\n' +
          'Commit or stash your changes before running undo.\n',
      );
      return { exitCode: 1 };
    }

    // 4. The transaction log must name the commit we're undoing.
    if (!log.bumpCommitSha) {
      stderr(
        'Error: transaction log is missing `bumpCommitSha`.\n' +
          'The log is incomplete and undo cannot run automatically.\n',
      );
      return { exitCode: 1 };
    }

    // 5. Resolve the parent commit BEFORE touching anything. If the
    // release commit is a root commit, `<sha>^` has no parent and
    // `git reset --hard` would fail midway — better to stop here and
    // give the user a clean manual recipe.
    const parent = await resolveRef(`${log.bumpCommitSha}^`, { cwd });
    if (!parent) {
      stderr(
        `Error: release commit ${log.bumpCommitSha.slice(0, 7)} has no parent (it is a root commit).\n` +
          'Automatic undo is not supported for root-commit releases. ' +
          'To recover manually:\n\n' +
          `  git update-ref -d HEAD\n` +
          `  git rm -rf .\n` +
          (log.tagName ? `  git tag -d ${log.tagName}\n` : ''),
      );
      return { exitCode: 1 };
    }

    // 6. Delete the tag (if one was created).
    if (log.tagName) {
      await deleteTag(log.tagName, { cwd });
    }

    // 7. Reset to the parent.
    await resetHard(parent, { cwd });

    // 8. Report success.
    stdout(
      `Undone: ${log.tagName ?? log.toVersion}\n` +
        `  Tag deleted:    ${log.tagName ?? '(none)'}\n` +
        `  Commit reverted: ${log.bumpCommitSha?.slice(0, 7) ?? '(none)'}\n` +
        `  Version restored: ${log.fromVersion}\n`,
    );

    return { exitCode: 0 };
  } catch (err) {
    stderr(formatError(err, { verbose: deps.verbose === true }));
    return { exitCode: 1 };
  }
}

// --------- citty wrapper ---------

export const undoCommand = defineCommand({
  meta: {
    name: 'undo',
    description: 'Revert the last local (unpushed) release.',
  },
  args: {
    verbose: {
      type: 'boolean',
      description: 'Verbose logging with debug detail',
      default: false,
    },
  },
  async run({ args }) {
    const result = await runUndo({ verbose: Boolean(args.verbose) });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
