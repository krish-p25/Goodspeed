import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

/**
 * LLMProvider — the core abstraction for all AI operations.
 *
 * This interface is owned by this project. The openai package is never
 * imported here. Adapters translate between these types and whatever SDK
 * they use internally.
 *
 * Chat and embedding are intentionally separate methods — they may be
 * served by different providers or models simultaneously.
 */
export interface LLMProvider {
  /**
   * Generate a chat completion. Resolves when the model finishes.
   * Use for non-streaming cases (background jobs, testing).
   */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>

  /**
   * Generate a streaming chat completion.
   * Yields ChatChunk objects as tokens arrive.
   * The final chunk will have done: true.
   */
  chatStream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk>

  /**
   * Generate embeddings for an array of text inputs.
   * Returns a parallel array of embedding vectors.
   * Vector length is fixed by the embedding model and must match the
   * database schema (1536 for text-embedding-3-small).
   */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * NestJS injection token for LLMProvider.
 * Consuming services use @Inject(LLM_PROVIDER) — they never import a
 * concrete class. This is what makes the provider genuinely swappable
 * via the DI container.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER')
