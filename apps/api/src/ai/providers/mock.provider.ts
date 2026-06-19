import type { LLMProvider } from '../llm-provider.interface'
import type { ChatMessage, ChatOptions, ChatResult, ChatChunk } from '@kb/types'

export class MockProvider implements LLMProvider {
  private readonly chatResponse: string
  private readonly embeddingDimension: number

  constructor(opts?: { chatResponse?: string; embeddingDimension?: number }) {
    this.chatResponse =
      opts?.chatResponse ?? 'This is a mock response from the AI provider.'
    this.embeddingDimension = opts?.embeddingDimension ?? 1536
  }

  async chat(_messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatResult> {
    return {
      content: this.chatResponse,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    }
  }

  async *chatStream(
    _messages: ChatMessage[],
    _opts?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const words = this.chatResponse.split(' ')
    for (const word of words) {
      yield { delta: word + ' ', done: false }
    }
    yield { delta: '', done: true }
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Deterministic non-zero vectors — index + 1 avoids zero-vector edge cases
    return texts.map((_, i) =>
      Array.from({ length: this.embeddingDimension }, () => (i + 1) * 0.01)
    )
  }
}
