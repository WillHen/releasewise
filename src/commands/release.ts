/**
 * `releasewise release` command.
 *
 * Structure:
 *
 *   - `runRelease(args, deps)` is the testable entry point. It takes
 *     parsed CLI args and a set of injectable dependencies (config
 *     loader, orchestrator, provider factory, env, output sinks) and
 *     returns `{ exitCode }`.
 *
 *   - `releaseCommand` is the thin citty wrapper — it just maps
 *     `args` into the runRelease shape and translates non-zero exit
 *     codes into `process.exit`.
 *
 * Two modes:
 *
 *   - Default (no flags): plan the release, render a preview, exit
 *     without writing anything. Safe by default — no tag push, no
 *     GitHub Release, no mutations.
 *
 *   - `--yes` (alias `--force-release`, `-y`): plan, render a preview,
 *     then execute (bump package.json, write CHANGELOG.md, commit,
 *     tag, push, create GitHub Release).
 *
 * All writes go through the injected `stdout` / `stderr` so tests can
 * capture them as strings. All errors are caught and rendered with
 * their message on stderr.
 */
import { defineCommand } from 'citty';

import {
  loadConfig as realLoadConfig,
  type LoadedConfig,
} from '../core/config-loader.ts';
import {
  resolveApiKey as realResolveApiKey,
  type ResolvedApiKey,
} from '../core/config-resolver.ts';
import { getProvider as realGetProvider } from '../core/ai/provider.ts';
import {
  collectReleaseInputs as realCollectReleaseInputs,
  executeRelease as realExecuteRelease,
  planRelease as realPlanRelease,
  type CollectReleaseInputsOptions,
  type ExecuteReleaseOptions,
  type ExecuteReleaseResult,
  type PlanReleaseOptions,
  type ReleaseInputs,
  type ReleasePlan,
} from '../core/orchestrator.ts';
import type { AIProvider, BumpType } from '../types.ts';
import { estimateTokens } from '../utils/token-estimator.ts';
import { formatHumanPreview, formatJsonPreview } from '../utils/preview.ts';

// --------- Public shape ---------

export interface RunReleaseArgs {
  bump?: string;
  mode?: string;
  pre?: string;
  from?: string;
  tone?: string;
  estimate?: boolean;
  noPush?: boolean;
  noGithubRelease?: boolean;
  json?: boolean;
  /**
   * Opt in to the destructive path: commit, tag, push, and create the
   * GitHub Release. Without this flag the command only renders a
   * preview. `--force-release` is a long alias for the same thing.
   */
  yes?: boolean;
  noAi?: boolean;
}

export interface RunReleaseDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  loadConfig?: (opts: { cwd?: string }) => LoadedConfig;
  resolveApiKey?: (
    config: LoadedConfig['config'],
    opts?: { env?: Record<string, string | undefined> },
  ) => ResolvedApiKey;
  getProvider?: (opts: {
    config: LoadedConfig['config'];
    apiKey: string;
  }) => AIProvider;
  collectReleaseInputs?: (
    opts: CollectReleaseInputsOptions,
  ) => Promise<ReleaseInputs>;
  planRelease?: (opts: PlanReleaseOptions) => Promise<ReleasePlan>;
  executeRelease?: (
    opts: ExecuteReleaseOptions,
  ) => Promise<ExecuteReleaseResult>;
}

export interface RunReleaseResult {
  exitCode: number;
}

// --------- runRelease ---------

export async function runRelease(
  args: RunReleaseArgs,
  deps: RunReleaseDeps = {},
): Promise<RunReleaseResult> {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(t));
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const loadConfig = deps.loadConfig ?? realLoadConfig;
  const resolveApiKey = deps.resolveApiKey ?? realResolveApiKey;
  const getProvider = deps.getProvider ?? realGetProvider;
  const collectReleaseInputs =
    deps.collectReleaseInputs ?? realCollectReleaseInputs;
  const planRelease = deps.planRelease ?? realPlanRelease;
  const executeRelease = deps.executeRelease ?? realExecuteRelease;

  try {
    // 1. Preview unless the caller explicitly opts in.
    //    The tool pushes tags, commits, and creates GitHub Releases —
    //    accidentally running one of those with a misclassified commit
    //    is expensive to undo, so the default is a read-only preview.
    const execute = args.yes === true;

    // 2. Validate string args before touching config or git.
    const forceBump = parseBumpArg(args.bump);
    const mode = parseModeArg(args.mode);
    const prerelease = parsePreArg(args.pre);
    const fromRef = parseFromArg(args.from);
    const tone = parseToneArg(args.tone);

    // 3. Load config.
    const loaded = loadConfig({ cwd });

    // 4. Build the provider (or null for --no-ai).
    let provider: AIProvider | null = null;
    if (!args.noAi) {
      const key = resolveApiKey(loaded.config, { env });
      provider = getProvider({ config: loaded.config, apiKey: key.key });
    }

    // 5. Collect repo inputs.
    const inputs = await collectReleaseInputs({
      cwd,
      config: loaded.config,
      fromRef,
    });

    // 5b. --estimate: print token/cost estimate and exit without calling AI.
    if (args.estimate) {
      const commitText = inputs.commits
        .map((c) => `${c.subject}\n${c.body}`)
        .join('\n');
      const inputTokens =
        estimateTokens(commitText) + estimateTokens(inputs.rawDiff);
      const maxOutputTokens = loaded.config.ai.maxOutputTokens;
      const estimate = {
        commits: inputs.commits.length,
        inputTokensEstimate: inputTokens,
        maxOutputTokens,
        totalTokensEstimate: inputTokens + maxOutputTokens,
      };
      if (args.json) {
        stdout(`${JSON.stringify(estimate, null, 2)}\n`);
      } else {
        stdout(
          `Token estimate for ${inputs.commits.length} commit(s):\n` +
            `  Input tokens:  ~${inputTokens.toLocaleString()}\n` +
            `  Max output:    ${maxOutputTokens.toLocaleString()}\n` +
            `  Total budget:  ~${(inputTokens + maxOutputTokens).toLocaleString()}\n`,
        );
      }
      return { exitCode: 0 };
    }

    // 6. Build the plan.
    const plan = await planRelease({
      inputs,
      config: loaded.config,
      provider,
      forceBump,
      prerelease,
      mode,
      tone,
    });

    // 7. Merge loader warnings in front of plan warnings (immutable).
    const merged: ReleasePlan = {
      ...plan,
      warnings: [...loaded.warnings, ...plan.warnings],
    };

    // 8. Default path: render preview and exit without touching anything.
    if (!execute) {
      if (args.json) {
        stdout(`${JSON.stringify(formatJsonPreview(merged), null, 2)}\n`);
      } else {
        stdout(`${formatHumanPreview(merged)}\n`);
      }
      return { exitCode: 0 };
    }

    // 9. Show the plan before executing so the user sees what's happening.
    if (!args.json) {
      stdout(`${formatHumanPreview(merged, { dryRun: false })}\n\n`);
    }

    // 10. Execute.
    const result = await executeRelease({
      plan: merged,
      config: loaded.config,
      cwd,
      noPush: args.noPush,
      noGithubRelease: args.noGithubRelease,
      env,
    });

    // 11. Render outcome.
    if (args.json) {
      stdout(
        `${JSON.stringify(
          {
            ...formatJsonPreview(merged, { dryRun: false }),
            executed: true,
            commitSha: result.commitSha,
            tagName: result.tagName,
            pushed: result.pushed,
            filesModified: result.filesModified,
            githubRelease: result.githubRelease,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const pushLine = result.pushed
        ? 'Pushed to remote.'
        : 'Not pushed (use `git push --follow-tags` to push manually).';
      let ghLine = '';
      if (result.githubRelease?.status === 'created') {
        ghLine = `  Release:   ${result.githubRelease.url}\n`;
      } else if (result.githubRelease?.status === 'skipped') {
        ghLine = `  Release:   skipped — ${result.githubRelease.reason}\n`;
      } else if (result.githubRelease?.status === 'failed') {
        ghLine =
          `  Release:   failed via ${result.githubRelease.method} — ${result.githubRelease.error}\n` +
          `             Retry manually: ${result.githubRelease.manualCommand}\n`;
      }
      stdout(
        `\nReleased ${result.tagName}\n` +
          `  Commit:    ${result.commitSha.slice(0, 7)}\n` +
          `  Tag:       ${result.tagName}\n` +
          `  Changelog: ${result.changelogPath}\n` +
          `  ${pushLine}\n` +
          ghLine,
      );
    }

    return { exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(`Error: ${message}\n`);
    return { exitCode: 1 };
  }
}

// --------- Arg validators ---------

function parseBumpArg(raw?: string): BumpType | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const normalized = raw.toLowerCase();
  if (
    normalized === 'major' ||
    normalized === 'minor' ||
    normalized === 'patch'
  ) {
    return normalized;
  }
  throw new Error(`--bump must be one of: major, minor, patch (got "${raw}")`);
}

function parseModeArg(raw?: string): 'conventional' | 'mixed' | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'conventional' || normalized === 'mixed') {
    return normalized;
  }
  if (normalized === 'manual') {
    throw new Error(
      '--mode manual is not supported in v1. Use --bump to force a specific ' +
        'bump, or pass --mode conventional or --mode mixed.',
    );
  }
  throw new Error(`--mode must be one of: conventional, mixed (got "${raw}")`);
}

function parsePreArg(raw?: string): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
    throw new Error(
      `--pre must be alphanumeric only (got "${raw}"). Example: --pre beta`,
    );
  }
  return trimmed;
}

function parseFromArg(raw?: string): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  return raw;
}

function parseToneArg(
  raw?: string,
): 'formal' | 'casual' | 'technical' | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const normalized = raw.toLowerCase();
  if (
    normalized === 'formal' ||
    normalized === 'casual' ||
    normalized === 'technical'
  ) {
    return normalized;
  }
  throw new Error(
    `--tone must be one of: formal, casual, technical (got "${raw}")`,
  );
}

// --------- citty wrapper ---------

export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description:
      'Analyze commits, bump version, write notes, tag and push. ' +
      'Previews by default; pass --yes to actually release.',
  },
  args: {
    bump: {
      type: 'string',
      description: 'Force bump type: major | minor | patch',
    },
    mode: {
      type: 'string',
      description: 'Commit analysis mode: conventional | mixed',
    },
    pre: {
      type: 'string',
      description: 'Pre-release label (e.g. beta, rc) -> 1.0.0-beta.0',
    },
    from: {
      type: 'string',
      description: 'Base ref for commit range (default: last tag)',
    },
    tone: {
      type: 'string',
      description: 'Release notes tone: formal | casual | technical',
    },
    yes: {
      type: 'boolean',
      alias: ['y', 'force-release'],
      description:
        'Execute the release (commit, tag, push, create GitHub Release). ' +
        'Without this flag the command only previews.',
      default: false,
    },
    // Negated booleans follow citty's convention: define the positive
    // option with default: true, and `--no-<name>` flips it to false.
    // Declaring the option as `'no-<name>'` directly does NOT work —
    // citty's auto-negation still produces `args.<name> = false`, while
    // the literal `no-<name>` key stays at its default.
    push: {
      type: 'boolean',
      description: 'Run git push after tagging (--no-push to skip)',
      default: true,
    },
    estimate: {
      type: 'boolean',
      description: 'Print token/cost estimate and exit without calling AI',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Structured JSON output',
      default: false,
    },
    ai: {
      type: 'boolean',
      description: 'Use AI for classification and notes (--no-ai for template fallback)',
      default: true,
    },
    'github-release': {
      type: 'boolean',
      description: 'Create a GitHub Release after pushing (--no-github-release to skip)',
      default: true,
    },
    credits: {
      type: 'boolean',
      description: 'Append contributor attribution to notes (v1.1+)',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress step logs and warnings',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Verbose logging with debug detail',
      default: false,
    },
  },
  async run({ args }) {
    // `push`, `ai`, and `github-release` are positive booleans (default
    // true); passing `--no-<name>` flips them to false, which is what
    // runRelease's negated `noX` fields represent.
    const result = await runRelease({
      bump: args.bump as string | undefined,
      mode: args.mode as string | undefined,
      pre: args.pre as string | undefined,
      from: args.from as string | undefined,
      tone: args.tone as string | undefined,
      estimate: Boolean(args.estimate),
      noPush: args.push === false,
      noGithubRelease: args['github-release'] === false,
      json: Boolean(args.json),
      yes: Boolean(args.yes),
      noAi: args.ai === false,
    });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
