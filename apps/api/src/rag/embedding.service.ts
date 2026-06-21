import { Injectable, Inject } from '@nestjs/common'
import { LLM_PROVIDER, LLMProvider } from '../ai/llm-provider.interface'

export interface EmbedResult {
  embeddings: number[][]
  totalTokens: number
}

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
  ) {}

  /**
   * Generate embeddings for an array of texts. Returns in input order,
   * alongside an estimated token count for the batch.
   */
  async embedTexts(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { embeddings: [], totalTokens: 0 }
    const embeddings = await this.llm.embed(texts)
    // Estimate: ~4 characters per token for English text.
    // Exact counts require an LLMProvider.embed() interface change — future work.
    const totalTokens = Math.ceil(
      texts.reduce((sum, t) => sum + t.length, 0) / 4,
    )
    return { embeddings, totalTokens }
  }

  /**
   * Serialise a number[] embedding to the Postgres vector string format
   * required by pgvector: "[v1,v2,v3,...]"
   *
   * IMPORTANT: supabase-js sends JS arrays as Postgres array literals
   * ("{v1,v2,...}") which pgvector does not accept. Serialising to the
   * vector string format "[...]" before insert is required.
   */
  toPostgresVector(embedding: number[]): string {
    return `[${embedding.join(',')}]`
  }
}
