/**
 * Anthropic AIProvider adapter — thin wrapper over the Messages API.
 *
 * This file is deliberately SDK-free at the type level: it accepts any
 * object shaped like `AnthropicClient`, which makes it trivial to inject
 * a fake in tests. The factory in `provider.ts` is the only place where
 * the real `@anthropic-ai/sdk` module is imported and a real client is
 * constructed.
 *
 * Generation calls are wrapped in `withRetry`. Transient failures
 * (network errors, HTTP 429, HTTP 5xx) are retried; HTTP 4xx responses
 * other than 429 are treated as fatal and re-thrown immediately — a
 * 400 Bad Request is not going to become a 200 on the third try.
 */
import type { AIGenerationResult, AIProvider } from '../../types.ts';
import { estimateTokens } from '../../utils/token-estimator.ts';
import { withRetry, type RetryOptions } from '../../utils/retry.ts';

// --------- Minimal structural types ---------

export interface AnthropicMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

export interface AnthropicMessage {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClient {
  messages: {
    create(params: AnthropicMessageParams): Promise<AnthropicMessage>;
  };
}

// --------- Factory ---------

export interface AnthropicAdapterOptions {
  /** An Anthropic client (real SDK instance or test fake). */
  client: AnthropicClient;
  /** Default model for `generate` calls. */
  model: string;
  /** Override retry options (used by tests for instant retries). */
  retry?: RetryOptions;
}

/** Fallback cap when the caller doesn't pass `maxTokens`. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Fallback temperature when the caller doesn't pass one. */
const DEFAULT_TEMPERATURE = 0.4;

export function createAnthropicProvider(
  opts: AnthropicAdapterOptions,
): AIProvider {
  const { client, model } = opts;

  return {
    name: 'anthropic',
    defaultModel: model,
    estimateTokens,
    async generate(request): Promise<AIGenerationResult> {
      const params: AnthropicMessageParams = {
        model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      };

      // Test-supplied retry options override the default shouldRetry.
      // Tests can pass `{ sleep: noSleep }` without wiping retry logic;
      // they can pass `{ shouldRetry: () => true }` to force retries on
      // errors that would normally be fatal.
      const response = await withRetry(() => client.messages.create(params), {
        shouldRetry: isRetryableError,
        ...opts.retry,
      });

      return {
        text: extractText(response),
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}

// --------- Helpers ---------

/** Concatenate every text block in a message, skipping non-text blocks. */
function extractText(message: AnthropicMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Classify an Anthropic SDK error as retryable or fatal.
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
