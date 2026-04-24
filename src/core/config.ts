/**
 * Config schema for releasewise.
 *
 * This file defines ONLY the shape + defaults. Loading, merging with
 * .releasewise.local.json, and resolving API keys from env vars lives in
 * config-loader.ts (step 2b) so this stays easy to unit-test.
 */
import { z } from 'zod';

// --------- Enums ---------

export const commitModeSchema = z.enum(['conventional', 'mixed', 'manual']);

export const providerNameSchema = z.enum([
  'anthropic',
  'openai',
  'groq',
  'gemini',
]);

export const changelogFormatSchema = z.enum([
  'individual',
  'changelog',
  'both',
]);

export const toneSchema = z.enum(['formal', 'casual', 'technical']);

// --------- Sub-objects ---------

export const aiConfigSchema = z.object({
  provider: providerNameSchema.default('anthropic'),
  // Sonnet, not Haiku: dogfood rounds 5-9 (see commit history) showed
  // Haiku 4.5 cannot reliably follow the release-notes prompt — it leaks
  // internal module names, test/CI bullets, and forbidden categories
  // despite explicit structural guidance. Sonnet 4.6 produces clean,
  // shippable notes on the same prompt. The cost delta is cents per
  // release at this workload, so default to the model that actually
  // works rather than the cheaper one. Override in .releasewise.json
  // if you want a different trade-off.
  model: z.string().min(1).default('claude-sonnet-4-6'),
  maxDiffTokens: z.number().int().positive().default(8000),
  maxOutputTokens: z.number().int().positive().default(2000),
  temperature: z.number().min(0).max(2).default(0.4),
  /**
   * Raw API key. STRONGLY DISCOURAGED in the committed config — the loader
   * will emit a warning if it finds a key here. Prefer env vars or
   * `.releasewise.local.json`.
   */
  apiKey: z.string().optional(),
  /** Optional custom base URL (e.g. Groq, Azure OpenAI, proxies). */
  baseUrl: z.string().url().optional(),
});

export const changelogConfigSchema = z.object({
  format: changelogFormatSchema.default('changelog'),
  path: z.string().min(1).default('CHANGELOG.md'),
  /** Used when format = 'individual' or 'both'. */
  individualDir: z.string().min(1).default('docs/releases'),
});

export const releaseConfigSchema = z.object({
  tagPrefix: z.string().default('v'),
  commitMessage: z.string().default('chore(release): v${version}'),
  pushOnRelease: z.boolean().default(true),
  createGithubRelease: z.boolean().default(true),
  tone: toneSchema.default('technical'),
});

// --------- Top-level config ---------

export const configSchema = z.object({
  $schema: z.string().optional(),
  projectName: z.string().min(1).optional(),
  commitMode: commitModeSchema.default('mixed'),
  ai: aiConfigSchema.prefault({}),
  changelog: changelogConfigSchema.prefault({}),
  release: releaseConfigSchema.prefault({}),
  language: z.string().default('en'),
});

/**
 * Fully-resolved config (all defaults applied). Use this type in downstream
 * modules so they never have to worry about undefined fields.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Input type: what users actually write in .releasewise.json. All fields
 * optional; defaults are filled in by the schema parser.
 */
export type ConfigInput = z.input<typeof configSchema>;

/** Convenience: an all-defaults config object (used in tests + `init`). */
export function defaultConfig(): Config {
  return configSchema.parse({});
}
