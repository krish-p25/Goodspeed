# Architecture Decisions

This document explains the significant architectural decisions made during
the build of the AI-Powered Knowledge Base, the trade-offs considered for
each, and the reasoning behind the choice made. It is intended to give
evaluators and future contributors a clear picture of why the system is
structured the way it is.

---

## 1. Monorepo structure — thin shared packages

### Decision
The `packages/` layer contains contracts and pure utilities only: shared
TypeScript types, Zod schemas, and ESLint/TypeScript config. All runtime
logic — the AI abstraction, Supabase clients, chunking, retrieval — lives
inside `apps/api` or `apps/web`.

### Options considered
- **Fat shared layer:** shared AI client, shared Supabase factories, shared
  business logic. Maximum code reuse.
- **Thin shared layer (chosen):** only types and config shared. Each app
  owns its runtime dependencies.

### Why thin
The two apps have fundamentally different runtime requirements. `apps/web`
uses `@supabase/ssr` with cookie-based session storage and
`NEXT_PUBLIC_`-prefixed environment variables exposed to the browser.
`apps/api` uses `@supabase/supabase-js` directly with persistent-session
disabled and server-only secrets. A shared Supabase factory would either
leak server config toward the browser or force the same initialisation
pattern on both — neither is acceptable.

Similarly, the AI abstraction lives in `apps/api` because it depends on
server-only secrets and never runs client-side. Putting it in `packages/`
would make those secrets importable from `apps/web`.

The practical rule applied: anything that can run safely in both a browser
and a Node.js context belongs in `packages/`. Everything else stays in its
app.

---

## 2. Authentication topology — BFF pattern with RLS

### Decision
All data traffic routes through the NestJS API (Backend for Frontend
pattern). The frontend never calls Supabase directly for data — only for
session management. The NestJS `AuthGuard` verifies every incoming JWT,
creates a request-scoped Supabase client carrying the user's access token,
and all database queries run through that client so Postgres Row Level
Security is enforced at the database layer.

### Options considered
- **Frontend calls Supabase directly for data:** simplest, leverages
  Supabase RLS natively, but splits data access across two surfaces and
  makes the NestJS layer feel bolted on.
- **NestJS as BFF with user-scoped client (chosen):** single API surface,
  centralised validation and logging, RLS enforced at DB layer.
- **NestJS with service-role key for all queries:** simplest server-side
  code, but bypasses RLS entirely — data isolation is only as good as the
  application's query logic.

### Why BFF with user-scoped client
The user-scoped client — initialised with the user's JWT on the
`Authorization` header — means PostgREST runs every query as that user.
RLS policies (`WHERE user_id = auth.uid()`) resolve correctly and enforce
per-user data isolation at the database layer. This gives defence in depth:
even a bug in the application query logic cannot leak another user's rows
because Postgres itself enforces the boundary.

The service-role admin client is used only where RLS legitimately needs to
be bypassed — embedding writes in `RagService`, usage tracking writes in
`TokenUsageService` — and in those cases `user_id` is set explicitly on
each inserted row to maintain correct data ownership.

### JWT verification
New Supabase projects use asymmetric JWT signing by default. The `AuthGuard`
uses `getClaims(jwt)` from `@supabase/supabase-js`, which verifies the JWT
locally against the cached JWKS endpoint — no Auth server network call per
request. `getUser()` is reserved for cases requiring a fresh server-confirmed
user record.

---

## 3. Database schema — user_id denormalised onto chunks

### Decision
The `chunks` table carries a `user_id` column directly, duplicating the
foreign key relationship that already exists via `document_id → documents.user_id`.

### Why
RLS policies on `chunks` can then be a simple equality check:
`(select auth.uid()) = user_id`. Without denormalisation, every RLS policy
would require a join back to `documents` on every row evaluated — measurably
slower on large tables and more complex SQL.

The `(select auth.uid())` wrapper around the function call is the Supabase-
recommended pattern: it causes Postgres to cache the result per statement
rather than evaluating it on every row.

The same denormalisation is applied to `messages` — `user_id` is stored
directly rather than derived through `conversation_id → conversations.user_id`.

### Trade-off
Denormalisation introduces the possibility of inconsistency if a write path
sets `user_id` incorrectly. This is mitigated by the BFF pattern: the only
code that sets `user_id` on inserts is server-side and reads the value from
the verified JWT payload — never from client input.

---

## 4. Vector index — HNSW over IVFFlat

### Decision
The `chunks` table uses an HNSW (Hierarchical Navigable Small World) index
with `vector_cosine_ops`.

### Options considered
- **IVFFlat:** requires a `VACUUM ANALYZE` and a tuned `lists` parameter
  after sufficient data is loaded. Better throughput at large scale.
- **HNSW (chosen):** better recall/latency from zero rows, no pre-training
  step, no `lists` parameter to tune.

### Why HNSW
For an application where documents are added incrementally and the dataset
grows from zero, IVFFlat's pre-training requirement is a meaningful
operational burden. HNSW is correct from the first insert and maintains
good recall without manual tuning. At the data volumes typical of a personal
knowledge base the performance difference is negligible.

The index uses `vector_cosine_ops` to match the `<=>` cosine distance
operator in `match_chunks`. The index operator class and query operator
must agree or the index is silently bypassed in favour of a full scan.

---

## 5. RAG retrieval — Postgres function via rpc()

### Decision
Vector similarity search is wrapped in a Postgres function (`match_chunks`)
and called via `supabase.rpc()` rather than a standard `.from().select()`
query.

### Why
PostgREST — the layer Supabase uses to expose Postgres as a REST API — does
not support pgvector similarity operators (`<=>`, `<->`, `<#>`). They cannot
be expressed in the standard query interface. The Postgres function approach
is the required pattern for any pgvector query through Supabase.

A secondary but important reason: user scoping (`WHERE c.user_id = p_user_id`)
is applied inside the SQL function rather than as a chained `.eq()` after
`.rpc()`. A post-execution filter via chaining is applied by PostgREST after
the function has already run — the vector planner cannot use it during index
traversal, which can produce fewer results than requested when the filter is
selective. Pushing the filter inside the function keeps the query planner
aware of it during HNSW traversal.

---

## 6. Chunking strategy

### Decision
Recursive character splitting: split on paragraph boundaries (`\n\n`) first,
then single newlines, then sentence-ending punctuation. Target chunk size is
configurable via `ai.config.json` (default 100 tokens for typical documents).
Overlap is 12% of the target.

### Options considered
- **Fixed token splitting:** simple, predictable, but splits mid-sentence
  and can sever context.
- **Recursive/structural splitting (chosen):** respects natural text
  boundaries, better semantic coherence.
- **Semantic chunking:** split on embedding similarity changes between
  sentences. Highest quality but requires an embedding call per sentence
  during chunking — expensive and slow.

### Why recursive splitting
Recursive splitting gives meaningful chunk boundaries without the cost of
semantic chunking. The overlap parameter ensures answers near chunk
boundaries are not lost. Token count is approximated as `word count × 1.3`,
which is accurate enough for chunking decisions without a tokeniser
dependency.

The target token size is intentionally made configurable in `ai.config.json`
and exposed on the settings page, because the right chunk size is
content-dependent — short factual documents benefit from smaller chunks for
precise retrieval; longer narrative documents benefit from larger chunks for
more context per result.

---

## 7. Synchronous embedding on document save

### Decision
Embedding generation happens synchronously in the same HTTP request as the
document save. The endpoint blocks until all chunks are embedded.

### Options considered
- **Synchronous (chosen):** simple, no extra infrastructure, document is
  immediately searchable after save.
- **Asynchronous via background queue:** responsive UX (instant save
  confirmation), but requires a job queue (BullMQ, Supabase Edge Functions,
  or pg_cron), a way to signal when embeddings are ready, and error handling
  for failed jobs.

### Why synchronous for now
For an assessment with modest document volumes, the embedding latency
(typically under two seconds for a typical document) is acceptable.
The synchronous path is simpler, has fewer failure modes, and the document
is immediately searchable.

A diff-on-update optimisation is applied: if only the title or tags change,
the content hash comparison detects no change and skips re-embedding
entirely. Only genuine content changes trigger chunking and embedding.

In production, this would move to a background queue so the API responds
immediately and embeddings are generated asynchronously. The README notes
this explicitly.

---

## 8. Provider-agnostic AI layer

### Decision
A clean `LLMProvider` interface with project-owned types (`ChatMessage`,
`ChatResult`, `ChatChunk`) and no dependency on the OpenAI SDK. A single
`OpenAICompatibleProvider` adapter implements the interface using the SDK,
with the SDK quarantined to that one file. A `MockProvider` for testing.
The active provider is selected via a Proxy pattern in the NestJS DI
container backed by `ai.config.json`.

### The Responses API decision
OpenAI introduced the Responses API (`/v1/responses`) in March 2025 as
their recommended path for new projects. However the Responses API is
OpenAI-proprietary — Groq, Together AI, OpenRouter, and Ollama all implement
the Chat Completions API (`/v1/chat/completions`) only. Building the
abstraction on the Responses API would have locked the project to OpenAI and
defeated the provider-agnostic requirement entirely. Chat Completions is the
correct foundation — it is the de facto standard that every alternative
provider follows.

### Hot-swap without restart
Provider behaviour (which provider, which model, which base URL) lives in
`apps/api/ai.config.json`. `AiConfigService` re-reads this file on every
call so changes take effect on the next request without a server restart.
API keys stay in `.env` and require a restart when changed — secrets must
not be committed to version control.

The NestJS `LLM_PROVIDER` token is a JavaScript `Proxy` that intercepts
every method call and delegates to the current provider from the config.
Consuming services inject `LLM_PROVIDER` and never import a concrete class
— the hot-swap mechanism is fully encapsulated in `AiModule`.

### API key resolution
Keys are resolved by provider name from `.env` via a `keyMap` in
`AiConfigService`. The config file declares `provider: "groq"` and the
service looks up `GROQ_API_KEY`. No key names are hardcoded in the config
file, no URL parsing, no ambiguity. Adding a new provider means adding its
key to `.env` and one entry to the `keyMap`.

### Chat and embedding independently configurable
The two providers are configured separately in `ai.config.json`. A
deployment might use Groq for fast chat and OpenAI for embeddings
simultaneously. Groq and Together AI do not offer embedding models, so the
independent configuration is practically necessary for users of those
providers.

### Embedding dimension coupling
The embedding model is coupled to the database schema — the `chunks.embedding`
column is `vector(1536)` for `text-embedding-3-small`. Switching to a model
that produces a different vector dimension requires a database migration. The
settings page warns about this. The chat model can be switched freely at any
time.

---

## 9. Prompt construction — strict grounding

### Decision
The system prompt instructs the model to answer only from the provided
context and to decline plainly when context is insufficient, rather than
drawing on its general training knowledge.

### Trade-off
Strict grounding makes the assistant decline more often (for off-topic
questions) but makes answers more trustworthy — users of a knowledge base
expect answers to come from their documents, not from the model's general
knowledge. Hallucination risk is reduced because the model is explicitly
told not to speculate.

The no-context short-circuit reinforces this: when retrieval returns nothing,
the LLM is not called at all. The decline response is instant, deterministic,
and costs nothing.

### Citation instruction
Sentence-level citation markers (`[c0_s1]`) are included in the citation
instruction appended to the grounding prompt. The model is told to cite only
IDs that appear in the provided context. Invalid IDs emitted by the model
are validated against the sentence map built at retrieval time and silently
dropped — hallucinated citations never reach the user. Document-level sources
from the known retrieved chunks remain the guaranteed floor regardless of
whether sentence-level markers resolve.

---

## 10. Streaming — SSE with typed event protocol

### Decision
Chat responses are streamed via Server-Sent Events from NestJS to the
frontend using a discriminated union event protocol:
`token | citation | sources | done | error`.

### Options considered
- **Polling:** client polls for response status. Simple but poor UX.
- **WebSockets:** bidirectional, appropriate for real-time collaboration
  but overkill for a one-way response stream.
- **SSE (chosen):** one-way server-to-client push, native HTTP, reconnect
  built into the protocol, simpler than WebSockets for this use case.

### Why typed events not raw text
A typed discriminated union makes the event protocol explicit and type-safe
on both ends. The frontend switches on `event.type` rather than parsing raw
text heuristically. Each event type carries only the fields it needs.
Adding a new event type (e.g. `progress` for long-running retrieval) is a
backwards-compatible additive change.

### EventSource vs Fetch API
The browser's native `EventSource` does not support custom headers or POST
requests. The `Authorization: Bearer` header required for auth makes
`EventSource` unusable here. The Fetch API with a streaming response reader
gives full control over headers and request method while still consuming the
SSE byte stream correctly.

### Citation buffering
Citation markers arrive split across token boundaries — `[c0_` in one token,
`_s1]` in the next. The `CitationStreamResolver` maintains a buffer and holds
back any trailing text that could still become the start of a marker. Complete
markers are resolved against the sentence map immediately; partial markers are
held until the next token disambiguates them. This ensures raw marker text
never appears in the UI regardless of how the model tokenises the citation.

---

## 11. Conversation history — last N messages window

### Decision
The last 6 messages (3 user/assistant pairs) from the conversation are
included in every prompt. History is re-fetched from the database on each
turn.

### Trade-off
Capping history prevents context window overflow on long conversations and
keeps token spend bounded. The known limitation: follow-up questions without
explicit context ("tell me more about that") are re-retrieved fresh based
only on the bare phrase, which may retrieve poorly. The production fix is
query rewriting — condensing the conversation history and the follow-up into
a standalone search query before embedding. This is noted in the README as
a planned improvement.

The window size (6) is configurable via `CONVERSATION_HISTORY_WINDOW` in
`.env` without a code change.

---

## 12. Token tracking — estimation vs exactness

### Decision
Chat streaming token counts are estimated from word count (`words × 1.3`).
Embedding token counts are estimated from character count (`characters ÷ 4`).
Neither is billing-grade exact.

### Why not exact
Exact streaming token counts require setting `stream_options: { include_usage: true }`
on the Chat Completions streaming call and parsing a final usage chunk. This
is a small but real change to the streaming path and was deferred in favour
of shipping the usage view with good-enough estimates.

Exact embedding token counts would require changing the `LLMProvider.embed()`
interface to return usage alongside the embedding vectors — a more invasive
change. The `embed()` method currently returns `number[][]` only.

Both improvements are noted in the README as future work. The estimates are
accurate enough for a usage monitor — the relative split between chat and
embedding spend, and the trend over time, are meaningful even with
approximation.

---

## Summary of key trade-offs

| Decision | What was gained | What was traded |
|---|---|---|
| Thin shared packages | Clear runtime boundaries, no secret leakage | Some code repetition between apps |
| BFF + user-scoped Supabase client | RLS defence in depth | Per-request client creation overhead |
| user_id denormalised on chunks | Simple, fast RLS policies | Potential for write-path inconsistency |
| HNSW index | Works from zero rows, no pre-training | Lower throughput at extreme scale |
| Postgres function for retrieval | Index-aware user filtering | Extra migration, rpc() call pattern |
| Recursive chunking | Respects text boundaries | More code than fixed-size splitting |
| Synchronous embedding | Simple, immediately searchable | Blocks HTTP response during embedding |
| Chat Completions not Responses API | All providers supported | Cannot use OpenAI stateful features |
| Hot-swap via config file | Provider changes without restart | File I/O on every request |
| Strict grounding prompt | Trustworthy, low hallucination | Declines more off-topic questions |
| SSE with typed events | Type-safe, extensible protocol | Cannot use native EventSource |
| Citation buffering resolver | Markers never appear as raw text | Complexity in stream handler |
| Estimated token counts | No interface changes required | Not billing-grade precise |
