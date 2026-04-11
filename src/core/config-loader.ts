/**
 * Loads and validates releasewise config.
 *
 * Discovery order (first hit wins for the "base" file):
 *   1. explicit path passed to loadConfig()
 *   2. .releasewise.json in cwd (or any ancestor, up to the git root / fs root)
 *
 * Merge order (later overrides earlier):
 *   1. base file              — committed, no secrets
 *   2. .releasewise.local.json — gitignored, same directory as base, may contain secrets
 *
 * Env vars and CLI flags are layered on top in config-resolver.ts (step 2c),
 * not here. This module is pure: fs in → validated Config out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { type z } from 'zod';

import { configSchema, type Config, type ConfigInput } from './config.ts';

export const CONFIG_FILENAME = '.releasewise.json';
export const LOCAL_CONFIG_FILENAME = '.releasewise.local.json';

export interface LoadedConfig {
  config: Config;
  /** Absolute path to the base config file, or null if none was found. */
  baseConfigPath: string | null;
  /** Absolute path to .releasewise.local.json, or null if none was found. */
  localConfigPath: string | null;
  /** Warnings emitted during load (e.g. apiKey in committed file). */
  warnings: string[];
}

export class ConfigNotFoundError extends Error {
  constructor(searchedFrom: string) {
    super(
      `No ${CONFIG_FILENAME} found starting from ${searchedFrom}. ` +
        `Run \`releasewise init\` to create one.`,
    );
    this.name = 'ConfigNotFoundError';
  }
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    super(`Invalid config in ${filePath}:\n${issues}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Walk up from `startDir` looking for `.releasewise.json`. Stops at the
 * filesystem root. Returns the absolute path or null.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit fs root
    dir = parent;
  }
}

/** Parse a JSON file into a plain object, throwing with a friendly message. */
function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Shallow-merge two config objects at the top level and at each sub-object
 * (ai / changelog / release). Primitives in the override win.
 *
 * We intentionally do NOT do a deep merge — the schema is only two levels
 * deep and an explicit two-level merge is easier to reason about than a
 * general-purpose deep-merge helper.
 */
export function mergeConfigInputs(
  base: ConfigInput,
  override: ConfigInput,
): ConfigInput {
  return {
    ...base,
    ...override,
    ai: { ...(base.ai ?? {}), ...(override.ai ?? {}) },
    changelog: { ...(base.changelog ?? {}), ...(override.changelog ?? {}) },
    release: { ...(base.release ?? {}), ...(override.release ?? {}) },
  };
}

/**
 * Load the config. In precedence: explicit path → ancestor search.
 * If a sibling `.releasewise.local.json` exists it's merged on top.
 *
 * Throws `ConfigNotFoundError` if no base file exists, or
 * `ConfigValidationError` if the merged result fails Zod validation.
 */
export function loadConfig(opts: {
  cwd?: string;
  /** Explicit path to the base config file. Skips the ancestor walk. */
  explicitPath?: string;
}): LoadedConfig {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const warnings: string[] = [];

  const baseConfigPath = opts.explicitPath
    ? resolve(opts.explicitPath)
    : findConfigFile(cwd);

  if (!baseConfigPath) throw new ConfigNotFoundError(cwd);
  if (!existsSync(baseConfigPath)) {
    throw new Error(`Config file does not exist: ${baseConfigPath}`);
  }

  const baseDir = dirname(baseConfigPath);
  const localConfigPathCandidate = join(baseDir, LOCAL_CONFIG_FILENAME);
  const localConfigPath = existsSync(localConfigPathCandidate)
    ? localConfigPathCandidate
    : null;

  const baseJson = readJson(baseConfigPath) as ConfigInput;
  const localJson = localConfigPath
    ? (readJson(localConfigPath) as ConfigInput)
    : {};

  // Warn about apiKey in the committed base file BEFORE merging, so we can
  // point at the actual offending file.
  if (baseJson?.ai?.apiKey) {
    warnings.push(
      `${CONFIG_FILENAME} contains ai.apiKey — this file is usually committed. ` +
        `Move the key to ${LOCAL_CONFIG_FILENAME} or an environment variable.`,
    );
  }

  const merged = mergeConfigInputs(baseJson ?? {}, localJson ?? {});

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    // Attribute the error to whichever file is most likely the source.
    const source = localConfigPath ?? baseConfigPath;
    throw new ConfigValidationError(source, parsed.error);
  }

  return {
    config: parsed.data,
    baseConfigPath,
    localConfigPath,
    warnings,
  };
}
