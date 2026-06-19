import { Injectable, Inject } from '@nestjs/common'
import { LLM_PROVIDER, LLMProvider } from '../ai/llm-provider.interface'

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
  ) {}

  /** Generate embeddings for an array of texts. Returns in input order. */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return this.llm.embed(texts)
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
