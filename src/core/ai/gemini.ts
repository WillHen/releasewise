/**
 * Gemini AIProvider adapter — thin wrapper over @google/genai SDK.
 *
 * Like the other adapters, this is SDK-free at the type level: it
 * accepts any object shaped like `GeminiClient`. The factory in
 * `provider.ts` imports the real `@google/genai` SDK and constructs
 * the client.
 */
import type { AIGenerationResult, AIProvider } from '../../types.ts';
import { estimateTokens } from '../../utils/token-estimator.ts';
import { withRetry, type RetryOptions } from '../../utils/retry.ts';

// --------- Minimal structural types ---------

export interface GeminiGenerateParams {
  model: string;
  contents: string;
  config?: {
    maxOutputTokens?: number;
    temperature?: number;
    systemInstruction?: string;
  };
}

export interface GeminiResponse {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export interface GeminiModel {
  generateContent(params: {
    model: string;
    contents: string;
    config?: GeminiGenerateParams['config'];
  }): Promise<GeminiResponse>;
}

// The subset of GoogleGenAI we use.
export type GeminiClient = GeminiModel;

// --------- Factory ---------

export interface GeminiAdapterOptions {
  client: GeminiClient;
  model: string;
  retry?: RetryOptions;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.4;

export function createGeminiProvider(opts: GeminiAdapterOptions): AIProvider {
  const { client, model } = opts;

  return {
    name: 'gemini',
    defaultModel: model,
    estimateTokens,
    async generate(request): Promise<AIGenerationResult> {
      const response = await withRetry(
        () =>
          client.generateContent({
            model,
            contents: request.user,
            config: {
              maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              temperature: request.temperature ?? DEFAULT_TEMPERATURE,
              systemInstruction: request.system || undefined,
            },
          }),
        {
          shouldRetry: isRetryableError,
          ...opts.retry,
        },
      );

      return {
        text: response.text ?? '',
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}

// --------- Helpers ---------

/**
 * Classify an SDK error as retryable or fatal.
 *
 * Errors without a numeric `status` field (connection resets, DNS, etc.)
 * are treated as retryable — better to try again than to fail fast on a
 * blip. HTTP 429 (rate limit) and 5xx (server) are retryable. Other 4xx
 * responses are fatal.
 */
function isRetryableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return true;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== 'number') return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status >= 400) return false;
  return true;
}
