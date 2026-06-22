# Phase 6 — Retrieval

> **For Claude Code:** Work through this in order. Stop at each verification
> gate and confirm it passes before continuing. This phase is purely backend —
> no UI changes. Report the completion checklist at the end.

---

## Context

Phase 6 builds the retrieval service — the read side of the RAG pipeline.
Given a user question and a user ID, it returns the most semantically
relevant document chunks from the database, ready to be injected into the
prompt in Phase 7.

The match_chunks Postgres function and HNSW index already exist from Phase 5.
This phase wires them into a NestJS service and verifies the three retrieval
cases that matter: a relevant question returns matching chunks, an off-topic
question returns an empty array, and a paraphrased question returns the
semantically correct chunk even when wording differs.

**Key decisions baked in:**
- Retrieval calls match_chunks via rpc() — the only supported path for
  pgvector similarity queries through supabase-js.
- The similarity threshold (0.35) and top-k (5) are read from env vars so
  they can be tuned without code changes.
- When match_chunks returns empty (nothing clears the threshold), the service
  returns [] — this is the signal Phase 7 uses to short-circuit the LLM call
  and return a no-context response.
- Sentence splitting and the sentence ID map for citations are built at
  retrieval time and attached to each returned chunk. This is needed by
  Phase 9 (span-level citations) and costs nothing to add now.
- ai.config.json must be set to openai for this phase's integration tests.
  Switch before testing, revert after.

---

## Step 1 — Switch ai.config.json to openai

```json
{
  "_comment": "Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.",
  "chat": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

---

## Step 2 — Add retrieval types to packages/types

Add to packages/types/src/index.ts:

```typescript
// ---------------------------------------------------------------------------
// Retrieval types
// ---------------------------------------------------------------------------

/**
 * A single sentence within a retrieved chunk, with a stable ID for
 * citation purposes and character offsets into the source document
 * for click-through highlighting.
 */
export interface CitableSentence {
  id: string           // e.g. "c1_s3" — chunk position 1, sentence 3
  chunkId: string
  documentId: string
  documentTitle: string
  text: string
  charStart: number    // character offset into document.content
  charEnd: number
}

/**
 * A retrieved chunk with its similarity score and sentence-level citation
 * data pre-computed at retrieval time.
 */
export interface RetrievedChunk {
  id: string
  documentId: string
  documentTitle: string
  content: string
  chunkIndex: number
  similarity: number
  // Sentence map: id -> CitableSentence
  // Populated at retrieval time for use by the citation resolver in Phase 9
  sentences: Map<string, CitableSentence>
}
```

**Gate:** npm run build --workspace=@kb/types succeeds.

---

## Step 3 — Retrieval service

### apps/api/src/rag/retrieval.service.ts

```typescript
import { Injectable, Inject } from '@nestjs/common'
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
    this.topK = parseInt(
      this.config.get<string>('RETRIEVAL_TOP_K', '5'),
      10,
    )
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
   * @param query     The user's question
   * @param userId    The authenticated user's ID — scopes search to their docs
   * @param topK      Override the default top-k (optional)
   * @param threshold Override the default threshold (optional)
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
    const documentIds = [...new Set((data as MatchChunksRow[]).map((r) => r.document_id))]
    const { data: documents } = await adminClient
      .from('documents')
      .select('id, title')
      .in('id', documentIds)

    const titleMap = new Map<string, string>(
      (documents ?? []).map((d: { id: string; title: string }) => [d.id, d.title])
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
   * Heuristic — not perfect for abbreviations, lists, or markdown headers,
   * but sufficient for the citation use case. A production system would
   * use a dedicated sentence segmenter.
   */
  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
}
```

---

## Step 4 — Export RetrievalService from RagModule

Update apps/api/src/rag/rag.module.ts:

```typescript
import { Module } from '@nestjs/common'
import { RagService } from './rag.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'
import { RetrievalService } from './retrieval.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports: [SupabaseModule, AiModule],
  providers: [RagService, ChunkingService, EmbeddingService, RetrievalService],
  exports: [RagService, RetrievalService],
})
export class RagModule {}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 5 — Temporary test endpoint

Create a temporary retrieval test endpoint to verify all three retrieval
cases before wiring the service into the chat pipeline in Phase 7.

### apps/api/src/rag/rag.controller.ts (temporary — remove after Phase 6)

```typescript
import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { RetrievalService } from './retrieval.service'

@Controller('retrieval-test')
@UseGuards(AuthGuard)
export class RagTestController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Get()
  async test(@Query('q') query: string, @Request() req: any) {
    if (!query) return { error: 'Provide a ?q= query param' }

    const chunks = await this.retrieval.retrieve({
      query,
      userId: req.user.id,
    })

    return {
      query,
      count: chunks.length,
      chunks: chunks.map((c) => ({
        documentTitle: c.documentTitle,
        similarity: c.similarity,
        contentPreview: c.content.slice(0, 120) + '...',
        sentenceCount: c.sentences.size,
      })),
    }
  }
}
```

Add RagTestController to RagModule's controllers array temporarily.

---

## Step 6 — Integration tests

Ensure you have at least one document saved with real content and embeddings
from Phase 5. If not, create one via the web app or the API before running
these tests.

With both apps running and ai.config.json set to openai, test using a REST
client with a valid Bearer token:

### Test 1 — Relevant question (should return chunks)

```
GET http://localhost:3010/retrieval-test?q=How does RAG work
Authorization: Bearer YOUR_TOKEN
```

Expected: count > 0, chunks array contains relevant content, similarity
scores are above 0.35.

**Gate:** At least one chunk returned with similarity > 0.35.

### Test 2 — Off-topic question (should return empty)

```
GET http://localhost:3010/retrieval-test?q=What is the capital of France
Authorization: Bearer YOUR_TOKEN
```

Expected: count = 0, chunks = []. Nothing in the knowledge base covers
French geography so nothing should clear the threshold.

**Gate:** Empty array returned. This confirms the threshold filter works
and the no-context path in Phase 7 will fire correctly.

### Test 3 — Paraphrased question (semantic matching)

Ask the same thing your document covers but with different wording:

```
GET http://localhost:3010/retrieval-test?q=How do you use documents to help AI answer questions
Authorization: Bearer YOUR_TOKEN
```

Expected: Relevant chunks returned even though the wording does not match
the document verbatim. This confirms the embedding-based similarity is
working semantically, not as keyword matching.

**Gate:** Relevant chunks returned for the paraphrased query.

### Test 4 — Sentence map populated

Check the sentence count in the response for any returned chunk. It should
be greater than 0 — the sentence map is being built at retrieval time.

**Gate:** sentenceCount > 0 for at least one returned chunk.

---

## Step 7 — Evaluate and tune threshold if needed

After running the three test queries, evaluate whether 0.35 is the right
threshold for your content:

- If Test 2 (off-topic) returns chunks: threshold is too low — increase
  RETRIEVAL_SIMILARITY_THRESHOLD in .env (try 0.45) and re-test. No restart
  needed for ai.config.json changes but .env changes do require a restart.
- If Test 1 (relevant) returns no chunks: threshold may be too high — try
  lowering to 0.25 and re-test.
- If Test 3 (paraphrased) returns no chunks but Test 1 does: the semantic
  gap is larger than the threshold allows — lower the threshold slightly.

The goal: relevant returns chunks, off-topic returns empty, paraphrased
returns chunks. Once that holds for your content, the threshold is correctly
tuned.

Document the final threshold value in the README — evaluators will
appreciate seeing empirical tuning noted rather than just a hardcoded default.

---

## Step 8 — Clean up

- Remove RagTestController from RagModule controllers array
- Delete apps/api/src/rag/rag.controller.ts
- Revert ai.config.json to mock default
- Confirm npm run build --workspace=@kb/api passes after removal

---

## Phase 6 completion checklist

- [ ] RetrievedChunk and CitableSentence types added to packages/types
- [ ] RetrievalService created with retrieve() method
- [ ] Sentence map built at retrieval time with stable citation IDs
- [ ] RetrievalService added to RagModule providers and exports
- [ ] Build passes cleanly
- [ ] Test 1: relevant question returns chunks with similarity > threshold
- [ ] Test 2: off-topic question returns empty array
- [ ] Test 3: paraphrased question returns semantically relevant chunks
- [ ] Test 4: sentence map populated (sentenceCount > 0)
- [ ] Threshold tuned and final value documented
- [ ] RagTestController removed
- [ ] ai.config.json reverted to mock default
- [ ] Build passes after cleanup

**Do not begin Phase 7 (Chat) until every box is checked.**

---

## Key design decisions (document in README later)

- **rpc() for similarity queries:** PostgREST does not support pgvector
  similarity operators. The match_chunks Postgres function (added in Phase 5)
  is called via rpc() — the only supported path through supabase-js.
- **Empty array as the no-context signal:** When nothing clears the
  threshold, retrieve() returns []. The chat service in Phase 7 checks for
  this and short-circuits — no LLM call, instant no-context response. This
  is cheaper, faster, and more predictable than asking the model to decline.
- **Threshold and top-k from env:** Both are configurable at runtime via
  .env without code changes. This enables empirical tuning against real
  content without a redeploy.
- **Sentence map at retrieval time:** Building the sentence ID map when
  chunks are retrieved (rather than at prompt construction time) keeps the
  citation logic self-contained and makes it available to both the prompt
  builder and the stream citation resolver in Phase 9.
- **Admin client for retrieval queries:** match_chunks is called via the
  admin client rather than the user-scoped client. The function itself
  enforces user scoping via the p_user_id parameter — the admin client just
  avoids the overhead of creating a per-request client for a read-only
  operation where RLS is already enforced inside the SQL function.
- **Document title join:** Titles are fetched separately after retrieval
  rather than joined inside match_chunks. This keeps the SQL function simple
  and avoids adding a JOIN that could affect the query planner's index usage.

---

## Explicitly out of scope for Phase 6

- Prompt construction (Phase 7)
- Chat endpoint or conversation management (Phase 7)
- Streaming (Phase 8)
- Span-level citation resolution (Phase 9)
- Hybrid search (keyword + vector) — noted in README as future improvement
- Re-ranking retrieved chunks — noted in README as future improvement
