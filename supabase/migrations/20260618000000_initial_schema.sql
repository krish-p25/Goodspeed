-- =============================================================================
-- Migration: initial_schema
-- Purpose: Create all tables for the AI knowledge base application
-- Tables: documents, chunks (pgvector), conversations, messages, message_sources
-- RLS: enabled on all tables with per-user policies
-- Notes:
--   - chunks.user_id is denormalised from documents for RLS performance
--   - HNSW index used over IVFFlat (no pre-training needed, better recall)
--   - auth.uid() wrapped in (select ...) per Supabase RLS performance guidance
--   - All policies scoped to 'authenticated' role only
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- pgvector: enables vector column type and similarity search operators
-- This is a safety net; the extension should already be enabled in the dashboard
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Table: documents
-- ---------------------------------------------------------------------------
-- Core user-created documents. The source content that gets chunked + embedded.

create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  content     text not null,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Index for fast per-user document listing (also used by RLS)
create index documents_user_id_idx on public.documents using btree (user_id);

-- Auto-update updated_at on row changes
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- RLS
alter table public.documents enable row level security;

create policy "documents: users can select own rows"
  on public.documents for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "documents: users can insert own rows"
  on public.documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "documents: users can update own rows"
  on public.documents for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "documents: users can delete own rows"
  on public.documents for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Table: chunks
-- ---------------------------------------------------------------------------
-- Document content split into segments with embeddings for vector search.
-- user_id is denormalised here so RLS can be a simple equality check
-- without joining back to documents on every vector query.

create table public.chunks (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.documents(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  content        text not null,
  chunk_index    integer not null,      -- position within the document (0-based)
  token_count    integer,               -- approximate token count for the chunk
  embedding      extensions.vector(1536), -- text-embedding-3-small dimensions
                                        -- IMPORTANT: changing embedding model/dimension
                                        -- requires a new migration to ALTER this column
  created_at     timestamptz not null default now()
);

-- Index for cascade deletes and per-document chunk lookups
create index chunks_document_id_idx on public.chunks using btree (document_id);

-- Index for per-user lookups (also used by RLS)
create index chunks_user_id_idx on public.chunks using btree (user_id);

-- HNSW vector index for fast approximate nearest-neighbour search
-- vector_cosine_ops must match the <=> operator used in retrieval queries
-- ef_construction and m are defaults; tune only if retrieval quality degrades
create index chunks_embedding_hnsw_idx on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RLS
alter table public.chunks enable row level security;

create policy "chunks: users can select own rows"
  on public.chunks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "chunks: users can insert own rows"
  on public.chunks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "chunks: users can delete own rows"
  on public.chunks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- No UPDATE policy on chunks: chunks are deleted and re-inserted on document edit,
-- never updated in place.

-- ---------------------------------------------------------------------------
-- Table: conversations
-- ---------------------------------------------------------------------------

create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,                     -- optional; can be set from first message
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index conversations_user_id_idx on public.conversations using btree (user_id);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;

create policy "conversations: users can select own rows"
  on public.conversations for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "conversations: users can insert own rows"
  on public.conversations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "conversations: users can update own rows"
  on public.conversations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "conversations: users can delete own rows"
  on public.conversations for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Table: messages
-- ---------------------------------------------------------------------------

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  created_at       timestamptz not null default now()
);

create index messages_conversation_id_idx on public.messages using btree (conversation_id);
create index messages_user_id_idx on public.messages using btree (user_id);

alter table public.messages enable row level security;

create policy "messages: users can select own rows"
  on public.messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "messages: users can insert own rows"
  on public.messages for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "messages: users can delete own rows"
  on public.messages for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Table: message_sources
-- ---------------------------------------------------------------------------
-- Span-level citations: records which exact sentence(s) in which chunk(s)
-- informed each assistant message.
-- sentence_text is stored resolved (not just a pointer) so citations survive
-- document edits and re-chunking.

create table public.message_sources (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.messages(id) on delete cascade,
  chunk_id       uuid references public.chunks(id) on delete set null,
  document_id    uuid references public.documents(id) on delete set null,
  sentence_text  text not null,         -- the exact cited sentence, resolved at answer time
  char_start     integer,               -- character offset into document.content (for highlighting)
  char_end       integer,
  position       integer not null,      -- citation order within the message (for stable footnote numbering)
  created_at     timestamptz not null default now()
);

create index message_sources_message_id_idx on public.message_sources using btree (message_id);

-- RLS: message_sources access is controlled via the parent message's user_id.
-- We check against messages to avoid adding a redundant user_id column here.
alter table public.message_sources enable row level security;

create policy "message_sources: users can select via own messages"
  on public.message_sources for select
  to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (select auth.uid()) = m.user_id
    )
  );

create policy "message_sources: users can insert via own messages"
  on public.message_sources for insert
  to authenticated
  with check (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (select auth.uid()) = m.user_id
    )
  );

create policy "message_sources: users can delete via own messages"
  on public.message_sources for delete
  to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (select auth.uid()) = m.user_id
    )
  );
