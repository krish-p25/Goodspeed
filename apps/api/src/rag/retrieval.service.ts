import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SupabaseService } from '../supabase/supabase.service'
import { EmbeddingService } from './embedding.service'
import type { RetrievedChunk, CitableSentence } from '@kb/types'

interface MatchChunksRow {
  id: string
  document_id: string
  content: string
  chunk_index: number
  similarity: number
}

@Injectable()
export class RetrievalService {
  private readonly topK: number
  private readonly threshold: number

  constructor(
    private readonly supabase: SupabaseService,
    private readonly embedding: EmbeddingService,
    private readonly config: ConfigService,
  ) {
    this.topK = parseInt(this.config.get<string>('RETRIEVAL_TOP_K', '5'), 10)
    this.threshold = parseFloat(
      this.config.get<string>('RETRIEVAL_SIMILARITY_THRESHOLD', '0.35'),
    )
  }

  /**
   * Retrieve the most relevant chunks for a given query.
   *
   * Returns [] when nothing clears the similarity threshold — this is the
   * signal used by the chat service in Phase 7 to short-circuit the LLM
   * call and return a no-context response rather than hallucinating.
   *
   * @param query      The user's question
   * @param userId     The authenticated user's ID — scopes search to their docs
   * @param topK       Override the default top-k (optional)
   * @param threshold  Override the default threshold (optional)
   * @param documentId Optionally scope retrieval to a single document
   */
  async retrieve(params: {
    query: string
    userId: string
    topK?: number
    threshold?: number
    documentId?: string
  }): Promise<RetrievedChunk[]> {
    const { query, userId, documentId } = params
    const topK = params.topK ?? this.topK
    const threshold = params.threshold ?? this.threshold

    // Embed the query using the same model as the stored chunks
    const [queryEmbedding] = await this.embedding.embedTexts([query])

    // Call match_chunks via rpc() — the only supported path for pgvector
    // similarity queries through supabase-js / PostgREST
    const adminClient = this.supabase.getAdminClient()
    const { data, error } = await adminClient.rpc('match_chunks', {
      query_embedding: this.embedding.toPostgresVector(queryEmbedding),
      p_user_id: userId,
      match_count: topK,
      match_threshold: threshold,
    })

    if (error) {
      throw new Error(`Retrieval failed: ${error.message}`)
    }

    if (!data || data.length === 0) {
      return []
    }

    // Fetch document titles for the matched chunks
    // Deduplicate document IDs to minimise queries
    const documentIds = [
      ...new Set((data as MatchChunksRow[]).map((r) => r.document_id)),
    ]
    const { data: documents } = await adminClient
      .from('documents')
      .select('id, title')
      .in('id', documentIds)

    const titleMap = new Map<string, string>(
      (documents ?? []).map((d: { id: string; title: string }) => [d.id, d.title]),
    )

    // Optionally filter to a specific document (for future per-doc chat UI)
    const rows = documentId
      ? (data as MatchChunksRow[]).filter((r) => r.document_id === documentId)
      : (data as MatchChunksRow[])

    // Build RetrievedChunk array with sentence maps for citation (Phase 9)
    return rows.map((row, chunkPosition) => {
      const docTitle = titleMap.get(row.document_id) ?? 'Unknown Document'
      const sentences = this.buildSentenceMap(
        row.content,
        row.id,
        row.document_id,
        docTitle,
        chunkPosition,
      )
      return {
        id: row.id,
        documentId: row.document_id,
        documentTitle: docTitle,
        content: row.content,
        chunkIndex: row.chunk_index,
        similarity: row.similarity,
        sentences,
      }
    })
  }

  /**
   * Split chunk content into sentences and assign stable citation IDs.
   *
   * ID format: "c{chunkPosition}_s{sentenceIndex}"
   * e.g. "c1_s3" = the 4th sentence of the 2nd retrieved chunk.
   *
   * IDs are short and positional (not UUID-based) so the LLM can
   * reproduce them accurately in citation markers.
   *
   * charStart/charEnd are offsets into chunk.content (not the full
   * document) — Phase 9 resolves these to document-level offsets
   * when persisting citations.
   */
  private buildSentenceMap(
    content: string,
    chunkId: string,
    documentId: string,
    documentTitle: string,
    chunkPosition: number,
  ): Map<string, CitableSentence> {
    const map = new Map<string, CitableSentence>()
    const sentences = this.splitSentences(content)
    let charOffset = 0

    sentences.forEach((text, sentenceIndex) => {
      const id = `c${chunkPosition}_s${sentenceIndex}`
      const start = content.indexOf(text, charOffset)
      const end = start + text.length
      charOffset = end

      map.set(id, {
        id,
        chunkId,
        documentId,
        documentTitle,
        text,
        charStart: start,
        charEnd: end,
      })
    })

    return map
  }

  /**
   * Split text into sentences on common sentence-ending punctuation.
   * Heuristic — sufficient for the citation use case at assessment scale.
   */
  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
}
