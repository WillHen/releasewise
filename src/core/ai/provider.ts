/**
 * AIProvider factory. Given a resolved config and API key, returns the
 * right adapter. This is the only place the real SDK clients are
 * imported and constructed — every other file in the codebase talks to
 * the narrow `AIProvider` interface (see `types.ts`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

import type { AIProvider } from '../../types.ts';
import type { Config } from '../config.ts';
import { createAnthropicProvider, type AnthropicClient } from './anthropic.ts';
import { createGeminiProvider, type GeminiClient } from './gemini.ts';
import { createOpenAIProvider, type OpenAIClient } from './openai.ts';

export interface GetProviderOptions {
  /** Fully-resolved config (defaults applied). */
  config: Config;
  /** API key for `config.ai.provider`, already resolved from env/flag/file. */
  apiKey: string;
  /** Inject a pre-built client (tests). */
  anthropicClient?: AnthropicClient;
  openaiClient?: OpenAIClient;
  geminiClient?: GeminiClient;
}

/** Groq's OpenAI-compatible API base URL. */
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export function getProvider(opts: GetProviderOptions): AIProvider {
  const { config, apiKey } = opts;
  const providerName = config.ai.provider;

  switch (providerName) {
    case 'anthropic': {
      const client =
        opts.anthropicClient ??
        (new Anthropic({ apiKey }) as unknown as AnthropicClient);
      return createAnthropicProvider({
        client,
        model: config.ai.model,
      });
    }
    case 'openai': {
      const client =
        opts.openaiClient ??
        (new OpenAI({
          apiKey,
          baseURL: config.ai.baseUrl,
        }) as unknown as OpenAIClient);
      return createOpenAIProvider({
        client,
        model: config.ai.model,
      });
    }
    case 'groq': {
      // Groq exposes an OpenAI-compatible API, so we reuse the OpenAI
      // SDK client (and the openaiClient test injection field).
      const client =
        opts.openaiClient ??
        (new OpenAI({
          apiKey,
          baseURL: config.ai.baseUrl ?? GROQ_BASE_URL,
        }) as unknown as OpenAIClient);
      return createOpenAIProvider({
        client,
        model: config.ai.model,
        providerName: 'groq',
      });
    }
    case 'gemini': {
      const client =
        opts.geminiClient ??
        (new GoogleGenAI({
          apiKey,
          ...(config.ai.baseUrl
            ? { httpOptions: { baseUrl: config.ai.baseUrl } }
            : {}),
        }) as unknown as GeminiClient);
      return createGeminiProvider({
        client,
        model: config.ai.model,
      });
    }
  }
}
