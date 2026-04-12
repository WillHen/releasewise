/**
 * OpenAI AIProvider adapter — thin wrapper over the Chat Completions API.
 *
 * Like the Anthropic adapter, this file is SDK-free at the type level:
 * it accepts any object shaped like `OpenAIClient`. The factory in
 * `provider.ts` imports the real `openai` SDK and constructs the client.
 */
import type { AIGenerationResult, AIProvider } from '../../types.ts';
import { estimateTokens } from '../../utils/token-estimator.ts';
import { withRetry, type RetryOptions } from '../../utils/retry.ts';

// --------- Minimal structural types ---------

export interface OpenAIChatParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

export interface OpenAIChatCompletion {
  choices: Array<{
    message: { content: string | null };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface OpenAIClient {
  chat: {
    completions: {
      create(params: OpenAIChatParams): Promise<OpenAIChatCompletion>;
    };
  };
}

// --------- Factory ---------

export interface OpenAIAdapterOptions {
  client: OpenAIClient;
  model: string;
  providerName?: 'openai' | 'groq';
  retry?: RetryOptions;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.4;

export function createOpenAIProvider(opts: OpenAIAdapterOptions): AIProvider {
  const { client, model, providerName = 'openai' } = opts;

  return {
    name: providerName,
    defaultModel: model,
    estimateTokens,
    async generate(request): Promise<AIGenerationResult> {
      const messages: OpenAIChatParams['messages'] = [];
      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }
      messages.push({ role: 'user', content: request.user });

      const params: OpenAIChatParams = {
        model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages,
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      };

      const response = await withRetry(
        () => client.chat.completions.create(params),
        {
          shouldRetry: isRetryableError,
          ...opts.retry,
        },
      );

      return {
        text: response.choices[0]?.message.content ?? '',
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
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
