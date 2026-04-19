/**
 * Resolves an API key for the configured AI provider, applying the
 * documented precedence:
 *
 *   1. explicit override (e.g. --api-key CLI flag)              [highest]
 *   2. Provider-specific env var                                [second]
 *      - anthropic → ANTHROPIC_API_KEY
 *      - openai    → OPENAI_API_KEY
 *      - groq      → GROQ_API_KEY
 *      - gemini    → GEMINI_API_KEY
 *   3. config.ai.apiKey (from .releasewise.local.json or the    [third]
 *      committed .releasewise.json — loader has already merged
 *      those and warned if the key came from the committed file)
 *
 * If none of the above produces a key, throws `MissingApiKeyError` with
 * a message spelling out exactly which env var would have worked.
 *
 * Deliberately no generic RELEASEWISE_API_KEY var: every official SDK
 * already looks at its own provider-specific env var, and a single
 * tool-specific name just confuses users who switch providers
 * (same key silently pointed at a different service → 401, no clue why).
 */
import { ErrorCodes } from '../errors.ts';
import type { Config } from './config.ts';
import type { ProviderName } from '../types.ts';

export const PROVIDER_ENV_VARS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export interface ResolveApiKeyOptions {
  /** `--api-key` CLI flag value. Wins over everything else. */
  explicit?: string;
  /** Override `process.env` — makes tests deterministic. */
  env?: Record<string, string | undefined>;
}

export interface ResolvedApiKey {
  key: string;
  source: 'explicit' | 'provider-env' | 'config-file';
  /** The env var name (when source is env-based). */
  envVarName?: string;
}

export class MissingApiKeyError extends Error {
  readonly code = ErrorCodes.API_KEY_MISSING;
  readonly hint =
    'Prefer the provider env var (listed above) for local dev and CI secrets.';
  constructor(public readonly provider: ProviderName) {
    const envVar = PROVIDER_ENV_VARS[provider];
    super(
      `No API key for provider "${provider}". Set one of:\n` +
        `  • ${envVar} environment variable\n` +
        `  • ai.apiKey in .releasewise.local.json (gitignored)\n` +
        `  • --api-key flag (not recommended outside CI)`,
    );
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Pure function: (config, options) → resolved key. `env` defaults to
 * `process.env` but can be injected for tests.
 */
export function resolveApiKey(
  config: Config,
  opts: ResolveApiKeyOptions = {},
): ResolvedApiKey {
  const env = opts.env ?? process.env;
  const provider = config.ai.provider;

  // 1. Explicit CLI flag
  if (opts.explicit && opts.explicit.length > 0) {
    return { key: opts.explicit, source: 'explicit' };
  }

  // 2. Provider-specific env var
  const providerVar = PROVIDER_ENV_VARS[provider];
  const providerEnvValue = env[providerVar];
  if (providerEnvValue && providerEnvValue.length > 0) {
    return {
      key: providerEnvValue,
      source: 'provider-env',
      envVarName: providerVar,
    };
  }

  // 3. Config file (already the merged result from loader)
  if (config.ai.apiKey && config.ai.apiKey.length > 0) {
    return { key: config.ai.apiKey, source: 'config-file' };
  }

  throw new MissingApiKeyError(provider);
}
