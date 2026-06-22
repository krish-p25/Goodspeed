# Phase 5 — RAG Write Path

> **For Claude Code:** Work through this in order. Stop at each verification
> gate and confirm it passes before continuing. No chat UI or retrieval logic
> is built here — this phase is purely the write side: chunk, embed, store.
> Report the completion checklist at the end.

---

## Context

Phase 5 wires the AI layer into the document lifecycle. When a document is
saved, its content is split into chunks, each chunk is embedded via the
LLMProvider, and the resulting vectors are stored in the chunks table ready
for retrieval in Phase 6.

It also adds the match_chunks Postgres function as a migration. This is
required because PostgREST (which supabase-js uses under the hood) does not
support pgvector similarity operators directly — similarity queries must be
wrapped in a Postgres function and called via rpc().

**Key decisions baked in:**
- Chunking is recursive: split on paragraphs first, then sentences, with
  ~500-800 token target and ~10-15% overlap. Plain TypeScript — no library
  needed.
- Embeddings are generated synchronously on document save. Old chunks are
  deleted and new ones inserted in sequence when content changes (diff on
  update). If content is unchanged on update, chunking and embedding are
  skipped entirely.
- Embedding vectors must be serialised as a Postgres vector string
  "[v1,v2,...]" before insert — supabase-js sends arrays as Postgres sets
  "{v1,v2,...}" which pgvector rejects. This is a silent bug if missed.
- The admin Supabase client is used for chunk writes. RLS on chunks requires
  user_id to match auth.uid(), but the admin client bypasses RLS — chunk
  inserts use the admin client and set user_id explicitly from the verified
  request user. This avoids the complexity of writing embeddings through the
  user-scoped client while still maintaining correct data ownership.
- ai.config.json must be set to the openai provider for real embedding calls.
  Switch it before running Phase 5 tests, revert to mock after.

---

## Step 1 — Switch ai.config.json to openai

Before any code is written, switch apps/api/ai.config.json to use the real
OpenAI provider so embedding calls work during testing. No restart needed.

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

Confirm OPENAI_API_KEY is set in .env with a real value before proceeding.

---

## Step 2 — Add the match_chunks migration

Create a new migration file in supabase/migrations/. Use the current UTC
timestamp in the filename:

```
supabase\migrations\20240102000000_match_chunks_function.sql
```

Paste this SQL:

```sql
-- =============================================================================
-- Migration: match_chunks_function
-- Purpose: Postgres function for vector similarity search via rpc().
-- Required because PostgREST (supabase-js) does not support pgvector
-- similarity operators directly — must be called via .rpc('match_chunks').
--
-- Notes:
--   - Filters by user_id inside the function (not as a PostgREST chain filter)
--     because chained .eq() after .rpc() is applied post-execution and cannot
--     use the vector index for filtering.
--   - similarity = 1 - cosine distance (range 0-1, higher = more similar)
--   - match_threshold is a similarity floor, not a distance ceiling
--   - Results are ordered by distance ASC (closest first) for correct ranking
-- =============================================================================

create or replace function match_chunks(
  query_embedding  extensions.vector(1536),
  p_user_id        uuid,
  match_count      int     default 5,
  match_threshold  float   default 0.35
)
returns table (
  id            uuid,
  document_id   uuid,
  content       text,
  chunk_index   int,
  similarity    float
)
language plpgsql
stable
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.content,
    c.chunk_index,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where
    c.user_id = p_user_id
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding asc
  limit match_count;
end;
$$;
```

Push the migration:

```
npx supabase db push
```

**Gate:** Migration applies with no errors. Confirm the function exists in
the Supabase dashboard under Database -> Functions.

---

## Step 3 — Chunking service

Create the chunking service in apps/api. This is pure TypeScript — no AI
calls, no Supabase calls. It takes a string and returns an array of text
chunks with overlap.

### apps/api/src/rag/chunking.service.ts

```typescript
import { Injectable } from '@nestjs/common'

export interface TextChunk {
  content: string
  index: number          // position within the document (0-based)
  tokenCount: number     // approximate token count
}

@Injectable()
export class ChunkingService {
  // Target chunk size in approximate tokens
  private readonly targetTokens = 600
  // Overlap as a fraction of target (10-15%)
  private readonly overlapFraction = 0.12

  /**
   * Split document content into overlapping chunks.
   * Strategy: split on double newlines (paragraphs) first, then on single
   * newlines, then on sentences. Merge small segments until the target
   * token size is reached, then carry overlap into the next chunk.
   *
   * Token count is approximated as word count * 1.3 — accurate enough for
   * chunking decisions without a tokeniser dependency.
   */
  chunk(content: string): TextChunk[] {
    if (!content.trim()) return []

    const segments = this.splitIntoSegments(content)
    const chunks: TextChunk[] = []
    let current: string[] = []
    let currentTokens = 0
    const overlapTokens = Math.floor(this.targetTokens * this.overlapFraction)

    for (const segment of segments) {
      const segmentTokens = this.estimateTokens(segment)

      // If adding this segment would exceed the target, flush current chunk
      if (currentTokens + segmentTokens > this.targetTokens && current.length > 0) {
        const chunkContent = current.join(' ').trim()
        if (chunkContent) {
          chunks.push({
            content: chunkContent,
            index: chunks.length,
            tokenCount: currentTokens,
          })
        }

        // Carry overlap: keep trailing segments up to overlapTokens
        const overlap: string[] = []
        let overlapCount = 0
        for (let i = current.length - 1; i >= 0; i--) {
          const t = this.estimateTokens(current[i])
          if (overlapCount + t > overlapTokens) break
          overlap.unshift(current[i])
          overlapCount += t
        }
        current = overlap
        currentTokens = overlapCount
      }

      current.push(segment)
      currentTokens += segmentTokens
    }

    // Flush the final chunk
    if (current.length > 0) {
      const chunkContent = current.join(' ').trim()
      if (chunkContent) {
        chunks.push({
          content: chunkContent,
          index: chunks.length,
          tokenCount: currentTokens,
        })
      }
    }

    return chunks
  }

  /**
   * Split content into segments by trying structural boundaries in order:
   * double newlines (paragraphs), single newlines, sentence endings.
   * Filters out empty/whitespace-only segments.
   */
  private splitIntoSegments(content: string): string[] {
    // Split on paragraph boundaries first
    const paragraphs = content
      .split(/\n\n+/)
      .flatMap((para) => {
        const tokens = this.estimateTokens(para)
        if (tokens <= this.targetTokens) return [para]
        // Paragraph is too large — split further on single newlines
        return para.split(/\n/).flatMap((line) => {
          const lineTokens = this.estimateTokens(line)
          if (lineTokens <= this.targetTokens) return [line]
          // Line is still too large — split on sentence boundaries
          return line.split(/(?<=[.!?])\s+/)
        })
      })
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    return paragraphs
  }

  /**
   * Approximate token count: word count * 1.3.
   * GPT tokenisers average ~1.3 tokens per word for English prose.
   * Accurate enough for chunking decisions.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3)
  }
}
```

**Gate:** No TypeScript errors. A quick sanity test can be done by
temporarily logging chunk output in the service and calling it with a sample
string — not required as a formal gate here, covered by the integration test
in Step 7.

---

## Step 4 — Embedding service

Wraps the LLMProvider.embed() call and handles the critical serialisation
step: converting number[] vectors into Postgres vector string format before
storing. This prevents the silent bug where supabase-js sends arrays as
Postgres sets ("{...}") which pgvector rejects.

### apps/api/src/rag/embedding.service.ts

```typescript
import { Injectable, Inject } from '@nestjs/common'
import { LLM_PROVIDER, LLMProvider } from '../ai/llm-provider.interface'

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
  ) {}

  /**
   * Generate embeddings for an array of text inputs.
   * Returns vectors in the same order as the input array.
   */
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
```

---

## Step 5 — RAG service (orchestrates chunk + embed + store)

The RAG service is the main orchestrator for the write path. It is called by
the DocumentsService when a document is created or updated.

### apps/api/src/rag/rag.service.ts

```typescript
import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'

@Injectable()
export class RagService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly chunking: ChunkingService,
    private readonly embedding: EmbeddingService,
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

    // Delete existing chunks for this document before re-processing.
    // This handles both the initial create (no chunks exist) and updates
    // (old chunks are replaced). Cascaded deletes on message_sources via
    // FK mean citations pointing to old chunks are also cleaned up.
    const { error: deleteError } = await adminClient
      .from('chunks')
      .delete()
      .eq('document_id', documentId)
      .eq('user_id', userId)

    if (deleteError) {
      throw new Error(`Failed to delete existing chunks: ${deleteError.message}`)
    }

    // If content is empty, stop here — no chunks to generate
    if (!content.trim()) return

    // Split content into chunks
    const chunks = this.chunking.chunk(content)
    if (chunks.length === 0) return

    // Generate embeddings for all chunks in a single batch call
    const texts = chunks.map((c) => c.content)
    const embeddings = await this.embedding.embedTexts(texts)

    // Build insert rows — serialise embeddings to Postgres vector string format
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
   * Delete all chunks for a document. Called when a document is deleted.
   * The FK cascade on chunks handles this automatically via the schema,
   * but this explicit call is kept for clarity and logging.
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
}
```

---

## Step 6 — RAG module

### apps/api/src/rag/rag.module.ts

```typescript
import { Module } from '@nestjs/common'
import { RagService } from './rag.service'
import { ChunkingService } from './chunking.service'
import { EmbeddingService } from './embedding.service'
import { SupabaseModule } from '../supabase/supabase.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports: [SupabaseModule, AiModule],
  providers: [RagService, ChunkingService, EmbeddingService],
  exports: [RagService],
})
export class RagModule {}
```

Import RagModule in AppModule.

**Gate:** npm run build --workspace=@kb/api succeeds with no TypeScript errors.

---

## Step 7 — Wire RagService into DocumentsService

Update DocumentsService to call RagService after create and update, and
to skip re-embedding on update when content has not changed.

### Update apps/api/src/documents/documents.service.ts

Add RagService as a constructor dependency:

```typescript
constructor(
  private supabase: SupabaseService,
  private rag: RagService,
) {}
```

Update the create method to call processDocument after the insert:

```typescript
async create(dto: CreateDocumentDto, userId: string, accessToken: string) {
  const client = this.supabase.getUserClient(accessToken)
  const { data, error } = await client
    .from('documents')
    .insert({
      title: dto.title,
      content: dto.content,
      tags: dto.tags ?? [],
      user_id: userId,
    })
    .select()
    .single()

  if (error || !data) throw new Error(error?.message ?? 'Failed to create document')

  // Process embeddings after successful insert.
  // If content is empty (stub document), processDocument returns early.
  await this.rag.processDocument(data.id, data.content, userId)

  return data
}
```

Update the update method to diff content before re-embedding:

```typescript
async update(
  id: string,
  dto: UpdateDocumentDto,
  userId: string,
  accessToken: string,
) {
  const client = this.supabase.getUserClient(accessToken)

  // Fetch the current document to check if content has changed
  const { data: existing } = await client
    .from('documents')
    .select('content')
    .eq('id', id)
    .eq('user_id', userId)
    .single()

  const { data, error } = await client
    .from('documents')
    .update({
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.tags !== undefined && { tags: dto.tags }),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error || !data) throw new NotFoundException('Document not found or update failed')

  // Only re-embed if content actually changed — avoids unnecessary API calls
  const contentChanged =
    dto.content !== undefined && dto.content !== existing?.content

  if (contentChanged) {
    await this.rag.processDocument(id, data.content, userId)
  }

  return data
}
```

Update the remove method to explicitly delete chunks before the document
(the FK cascade handles this, but being explicit is good practice):

```typescript
async remove(id: string, userId: string, accessToken: string) {
  await this.rag.deleteDocumentChunks(id, userId)

  const client = this.supabase.getUserClient(accessToken)
  const { error } = await client
    .from('documents')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) throw new NotFoundException('Document not found or delete failed')
  return { success: true }
}
```

Update DocumentsModule to import RagModule:

```typescript
@Module({
  imports: [SupabaseModule, AuthModule, RagModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
```

**Gate:** npm run build --workspace=@kb/api succeeds.

---

## Step 8 — Integration test

With both apps running and ai.config.json set to openai:

### Test 1: Create a document with real content

Using a REST client with a valid Bearer token:

```
POST http://localhost:3010/documents
Body:
{
  "title": "Introduction to RAG",
  "content": "Retrieval Augmented Generation (RAG) is a technique that combines information retrieval with language model generation.\n\nThe process works by first splitting documents into smaller chunks. Each chunk is then converted into a vector embedding using an embedding model. These embeddings are stored in a vector database.\n\nWhen a user asks a question, the question is also embedded. The system finds the chunks whose embeddings are most similar to the question embedding. These chunks are then provided as context to the language model, which generates an answer grounded in the retrieved content.\n\nThis approach allows language models to answer questions about specific documents without requiring the entire document to fit in the context window.",
  "title": "Introduction to RAG"
}
```

Then verify in the Supabase dashboard:
- Go to Table Editor -> chunks
- Filter by document_id matching the returned document id
- Confirm multiple rows exist with content, chunk_index, and non-null embedding

**Gate:** Multiple chunk rows exist for the document. Embedding column shows
a vector value (not null).

### Test 2: Verify embedding dimensions

Run this in the Supabase SQL editor:

```sql
select
  id,
  chunk_index,
  token_count,
  left(content, 80) as content_preview,
  vector_dims(embedding) as embedding_dims
from public.chunks
order by chunk_index asc;
```

**Gate:** embedding_dims column shows 1536 for all rows.

### Test 3: Verify content diff on update

Update the document title only (no content change):

```
PATCH http://localhost:3010/documents/:id
Body: { "title": "Updated Title" }
```

Check the API server logs — no embedding call should have been made.

Update the document with new content:

```
PATCH http://localhost:3010/documents/:id
Body: { "content": "This is completely new content for the document." }
```

Check the chunks table — old chunks should be replaced with new ones
reflecting the updated content.

**Gate:** Title-only update produces no new chunks. Content update replaces
chunks correctly.

### Test 4: Verify delete cleans up chunks

Delete the document:

```
DELETE http://localhost:3010/documents/:id
```

Check the chunks table — no rows should remain for that document_id.

**Gate:** Chunks are removed on document delete.

---

## Step 9 — Revert ai.config.json to mock default

After all gates pass, revert ai.config.json to the mock default. Phase 6
will switch it back to openai for retrieval testing.

```json
{
  "_comment": "Provider behaviour config. Change and save — takes effect on next request, no restart needed. API keys stay in .env and require a restart when changed.",
  "chat": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  },
  "embedding": {
    "provider": "mock",
    "baseUrl": "",
    "model": ""
  }
}
```

---

## Phase 5 completion checklist

- [ ] ai.config.json switched to openai for testing
- [ ] match_chunks migration created and pushed successfully
- [ ] match_chunks function visible in Supabase dashboard
- [ ] ChunkingService created with recursive paragraph/sentence splitting
- [ ] EmbeddingService created with toPostgresVector serialisation
- [ ] RagService created — processDocument and deleteDocumentChunks
- [ ] RagModule created and imported in AppModule
- [ ] DocumentsService.create calls processDocument after insert
- [ ] DocumentsService.update diffs content and only re-embeds on change
- [ ] DocumentsService.remove calls deleteDocumentChunks
- [ ] DocumentsModule imports RagModule
- [ ] Build passes cleanly
- [ ] Chunks appear in DB after document create (multiple rows, correct dims)
- [ ] embedding_dims = 1536 confirmed via SQL query
- [ ] Title-only update produces no re-embedding
- [ ] Content update replaces chunks correctly
- [ ] Document delete removes all associated chunks
- [ ] ai.config.json reverted to mock default

**Do not begin Phase 6 (Retrieval) until every box is checked.**

---

## Key design decisions (document in README later)

- **Synchronous embedding on save:** Embedding happens in the same request
  as the document save. This blocks the response until embeddings are
  generated. For an assessment this is fine. In production this would move
  to a background queue (BullMQ, Supabase Edge Functions, pg_cron) so the
  API responds immediately and embeddings are generated asynchronously.
- **Diff on update:** Content is compared before re-embedding. A title or
  tag change does not trigger embedding API calls. Only actual content
  changes result in chunk deletion and re-generation. This keeps API costs
  low and avoids unnecessary latency on minor edits.
- **Admin client for chunk writes:** Embedding generation is a server-side
  operation not tied to a user session. The admin client is used for chunk
  inserts with user_id set explicitly on each row — correct data ownership
  without the complexity of threading a user access token through background
  operations.
- **Postgres vector string serialisation:** supabase-js sends JS arrays as
  Postgres array literals ("{...}"). pgvector requires vector string format
  ("[...]"). The toPostgresVector() method handles this conversion — missing
  it causes a silent insert failure.
- **match_chunks as a Postgres function:** PostgREST does not support
  pgvector similarity operators. Wrapping the similarity query in a Postgres
  function and calling it via rpc() is the required pattern. User scoping
  is applied inside the function — chaining .eq() after .rpc() is applied
  post-execution and cannot use the vector index.
- **Chunking strategy:** Recursive splitting on paragraphs → lines →
  sentences with ~600 token target and ~12% overlap. Token count approximated
  as word count * 1.3. Overlap ensures answers are not lost at chunk
  boundaries. In production a proper tokeniser (tiktoken) would give exact
  counts but adds a dependency not warranted at assessment scale.

---

## Explicitly out of scope for Phase 5

- Retrieval / vector similarity search (Phase 6)
- Chat endpoint or prompt construction (Phase 7)
- Streaming (Phase 8)
- Citations (Phase 9)
- Background job queues for async embedding
- Exact tokenisation (approximate is sufficient)
