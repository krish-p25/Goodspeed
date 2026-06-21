import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'
import { TokenUsageService } from '../usage/token-usage.service'
import * as fs from 'fs'
import * as path from 'path'

@Injectable()
export class RagService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly chunking: ChunkingService,
    private readonly embedding: EmbeddingService,
    private readonly tokenUsage: TokenUsageService,
  ) {}

  /**
   * Process a document: chunk its content, generate embeddings, and store
   * the chunks in the database. Deletes existing chunks first so re-processing
   * a document always results in a clean, up-to-date chunk set.
   *
   * Uses the admin client for chunk writes because embedding generation is a
   * server-side operation. user_id is set explicitly on each row so RLS data
   * ownership is maintained even though the admin client bypasses RLS.
   */
  async processDocument(
    documentId: string,
    content: string,
    userId: string,
  ): Promise<void> {
    const adminClient = this.supabase.getAdminClient()

    // Delete existing chunks before re-processing — handles both initial
    // create (no chunks exist) and updates (old chunks replaced).
    const { error: deleteError } = await adminClient
      .from('chunks')
      .delete()
      .eq('document_id', documentId)
      .eq('user_id', userId)

    if (deleteError) {
      throw new Error(`Failed to delete existing chunks: ${deleteError.message}`)
    }

    if (!content.trim()) return

    const chunks = this.chunking.chunk(content)
    if (chunks.length === 0) return

    const texts = chunks.map((c) => c.content)
    const { embeddings, totalTokens } = await this.embedding.embedTexts(texts)

    // Record embedding token usage — fire and forget, never block the save
    this.tokenUsage
      .recordEmbedding({
        userId,
        totalTokens,
        model: this.getCurrentEmbedModel(),
      })
      .catch(() => {})

    const rows = chunks.map((chunk, i) => ({
      document_id: documentId,
      user_id: userId,
      content: chunk.content,
      chunk_index: chunk.index,
      token_count: chunk.tokenCount,
      // Critical: must be "[v1,v2,...]" not a JS array
      embedding: this.embedding.toPostgresVector(embeddings[i]),
    }))

    const { error: insertError } = await adminClient
      .from('chunks')
      .insert(rows)

    if (insertError) {
      throw new Error(`Failed to insert chunks: ${insertError.message}`)
    }
  }

  /**
   * Delete all chunks for a document. Called on document delete.
   * The FK cascade handles this automatically, but explicit deletion
   * here ensures errors surface clearly.
   */
  async deleteDocumentChunks(
    documentId: string,
    userId: string,
  ): Promise<void> {
    const adminClient = this.supabase.getAdminClient()
    const { error } = await adminClient
      .from('chunks')
      .delete()
      .eq('document_id', documentId)
      .eq('user_id', userId)

    if (error) {
      throw new Error(`Failed to delete chunks: ${error.message}`)
    }
  }

  /**
   * Read the currently-configured embedding model from ai.config.json so the
   * recorded usage row reflects the model actually used. Falls back to
   * 'unknown' if the file is missing or unreadable.
   */
  private getCurrentEmbedModel(): string {
    try {
      const raw = fs.readFileSync(
        path.resolve(process.cwd(), 'ai.config.json'),
        'utf-8',
      )
      return JSON.parse(raw)?.embedding?.model ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
