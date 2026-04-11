/**
 * AIProvider factory. Given a resolved config and API key, returns the
 * right adapter. This is the only place the real SDK clients are
 * imported and constructed — every other file in the codebase talks to
 * the narrow `AIProvider` interface (see `types.ts`).
 *
 * Milestone A scope: **Anthropic only**. The OpenAI, Groq, and Gemini
 * adapters land in Step 10 (Milestone B). Until then the factory throws
 * a clear "not yet implemented" error for those providers so a user
 * who accidentally configures one gets a readable message instead of a
 * cryptic crash.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { AIProvider } from '../../types.ts';
import type { Config } from '../config.ts';
import { createAnthropicProvider, type AnthropicClient } from './anthropic.ts';

export interface GetProviderOptions {
  /** Fully-resolved config (defaults applied). */
  config: Config;
  /** API key for `config.ai.provider`, already resolved from env/flag/file. */
  apiKey: string;
  /**
   * Inject a pre-built Anthropic client. Used by tests to avoid hitting
   * the real API, and could later be used to pass a custom base URL.
   */
  anthropicClient?: AnthropicClient;
}

export function getProvider(opts: GetProviderOptions): AIProvider {
  const { config, apiKey, anthropicClient } = opts;
  const providerName = config.ai.provider;

  switch (providerName) {
    case 'anthropic': {
      const client =
        anthropicClient ??
        // The real SDK client is shaped like our AnthropicClient
        // interface for the one method we call; we narrow via `unknown`.
        (new Anthropic({ apiKey }) as unknown as AnthropicClient);
      return createAnthropicProvider({
        client,
        model: config.ai.model,
      });
    }
    case 'openai':
    case 'groq':
    case 'gemini':
      throw new Error(
        `Provider "${providerName}" is not yet implemented. ` +
          `releasewise v1 Milestone A ships Anthropic only; ` +
          `OpenAI, Groq, and Gemini land in Step 10 (Milestone B). ` +
          `Until then, set ai.provider to "anthropic" in .releasewise.json.`,
      );
  }
}
