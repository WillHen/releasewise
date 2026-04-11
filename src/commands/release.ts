/**
 * `releasewise release` command.
 *
 * Milestone A scope: **dry-run only**. The full write path (bump
 * package.json, commit, tag, push, GitHub Release) lands in Step 12b
 * — this command refuses to run without `--dry-run` for now so users
 * don't get a silent no-op when they expected a real release.
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
  planRelease as realPlanRelease,
  type CollectReleaseInputsOptions,
  type PlanReleaseOptions,
  type ReleaseInputs,
  type ReleasePlan,
} from '../core/orchestrator.ts';
import type { AIProvider, BumpType } from '../types.ts';
import { formatHumanPreview, formatJsonPreview } from '../utils/preview.ts';

// --------- Public shape ---------

export interface RunReleaseArgs {
  bump?: string;
  mode?: string;
  pre?: string;
  from?: string;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  noAi?: boolean;
}

export interface RunReleaseDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** True if stdin is a TTY. Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
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
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const loadConfig = deps.loadConfig ?? realLoadConfig;
  const resolveApiKey = deps.resolveApiKey ?? realResolveApiKey;
  const getProvider = deps.getProvider ?? realGetProvider;
  const collectReleaseInputs =
    deps.collectReleaseInputs ?? realCollectReleaseInputs;
  const planRelease = deps.planRelease ?? realPlanRelease;

  try {
    // 1. Scope gate — Milestone A is dry-run only.
    if (!args.dryRun) {
      stderr(
        'Error: releasewise is in Milestone A — only `release --dry-run` is supported right now.\n' +
          'The write path (package.json bump, commit, tag, push, GitHub Release) lands in Step 12b.\n',
      );
      return { exitCode: 1 };
    }

    // 2. Record the effective --yes (TTY auto-detect). Not used in
    //    dry-run since we don't prompt, but keeps parity with the
    //    Milestone B write path and future tests.
    void (args.yes ?? !isTTY);

    // 3. Validate string args before touching config or git.
    const forceBump = parseBumpArg(args.bump);
    const mode = parseModeArg(args.mode);
    const prerelease = parsePreArg(args.pre);
    const fromRef = parseFromArg(args.from);

    // 4. Load config.
    const loaded = loadConfig({ cwd });

    // 5. Build the provider (or null for --no-ai).
    let provider: AIProvider | null = null;
    if (!args.noAi) {
      const key = resolveApiKey(loaded.config, { env });
      provider = getProvider({ config: loaded.config, apiKey: key.key });
    }

    // 6. Collect repo inputs and build the plan.
    const inputs = await collectReleaseInputs({
      cwd,
      config: loaded.config,
      fromRef,
    });
    const plan = await planRelease({
      inputs,
      config: loaded.config,
      provider,
      forceBump,
      prerelease,
      mode,
    });

    // 7. Merge loader warnings in front of plan warnings (immutable).
    const merged: ReleasePlan = {
      ...plan,
      warnings: [...loaded.warnings, ...plan.warnings],
    };

    // 8. Render.
    if (args.json) {
      stdout(`${JSON.stringify(formatJsonPreview(merged), null, 2)}\n`);
    } else {
      stdout(`${formatHumanPreview(merged)}\n`);
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

// --------- citty wrapper ---------

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
      description: 'formal | casual | technical (Milestone B)',
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip all prompts',
      default: false,
    },
    'no-push': {
      type: 'boolean',
      description: 'Do not run git push (Milestone B)',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Run AI + preview but make no changes',
      default: false,
    },
    estimate: {
      type: 'boolean',
      description: 'Print token/cost estimate and exit (Milestone B)',
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
      description: 'Skip GitHub Release creation (Milestone B)',
      default: false,
    },
    credits: {
      type: 'boolean',
      description: 'Append contributor attribution to notes (Milestone B)',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress step logs (Milestone B)',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Verbose logging (Milestone B)',
      default: false,
    },
  },
  async run({ args }) {
    // citty exposes dashed flags under their original keys. Bridge to
    // the camelCase shape runRelease expects.
    const result = await runRelease({
      bump: args.bump as string | undefined,
      mode: args.mode as string | undefined,
      pre: args.pre as string | undefined,
      from: args.from as string | undefined,
      dryRun: Boolean(args['dry-run']),
      json: Boolean(args.json),
      yes: Boolean(args.yes),
      noAi: Boolean(args['no-ai']),
    });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  },
});
