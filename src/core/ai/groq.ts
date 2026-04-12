/**
 * Groq AIProvider adapter — reuses the OpenAI adapter since Groq
 * exposes an OpenAI-compatible Chat Completions API.
 *
 * The factory in `provider.ts` constructs an OpenAI SDK client with
 * Groq's base URL and passes it here. This file re-exports the
 * relevant types and provides a thin convenience wrapper.
 */
export {
  createOpenAIProvider as createGroqProvider,
  type OpenAIAdapterOptions as GroqAdapterOptions,
  type OpenAIClient as GroqClient,
  type OpenAIChatCompletion as GroqChatCompletion,
  type OpenAIChatParams as GroqChatParams,
} from './openai.ts';
