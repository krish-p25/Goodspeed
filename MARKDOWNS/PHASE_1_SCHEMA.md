# Phase 1 — Database Schema, Migrations & RLS

> **For Claude Code:** Work through this in order. Do not skip sections or
> apply schema changes through the Supabase dashboard SQL editor — all changes
> must go through migration files only. Stop at each verification gate and
> confirm it passes before continuing. Report the completion checklist at the
> end.

---

## Context

Phase 1 creates the complete database schema for the knowledge base app:
documents, chunks (with pgvector embeddings), conversations, messages, and
message sources. Every table gets RLS enabled with correct policies.

**No application code is written in this phase.** This is purely database
schema and migration setup.

**Stack context:**
- Supabase cloud project (already provisioned, CLI already linked)
- pgvector extension (already enabled in dashboard)
- Migration files live in `supabase/migrations/`
- Push command: `npx supabase db push`
- New project uses the new API key model:
  - `SUPABASE_PUBLISHABLE_KEY` = low-privilege client key (replaces anon)
  - `SUPABASE_SECRET_KEY` = elevated server key (replaces service_role)
  - `SUPABASE_JWKS_URL` = for JWT verification in Phase 2

---

## Step 1 — Confirm CLI is linked

Before writing any migrations, verify the CLI is still connected:

```cmd
npx supabase projects list
```

Your project should appear in the list. If it does not, re-run:

```cmd
npx supabase link --project-ref YOUR_PROJECT_REF_ID
```

**Gate:** Project appears in `npx supabase projects list`.

---

## Step 2 — Create the migration file

Create a single migration file for the entire initial schema. The filename
must follow the format `YYYYMMDDHHmmss_description.sql`. Create it manually
rather than using `supabase migration new` to avoid timestamp conflicts on
Windows.

Create the file at this path (adjust the timestamp to the current UTC time):

```
supabase\migrations\20240101000000_initial_schema.sql
```

Paste the full SQL below into that file:

```sql
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
  embedding      vector(1536),          -- text-embedding-3-small dimensions
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
  using hnsw (embedding vector_cosine_ops)
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
```

---

## Step 3 — Dry run (verify before applying)

Before pushing to the live database, do a dry run to see exactly what will
be applied:

```cmd
npx supabase db push --dry-run
```

Read the output. You should see all five tables and their indexes listed as
pending. If there are errors in the SQL they will surface here without
touching the database.

**Gate:** Dry run completes with no errors and lists all five tables.

---

## Step 4 — Push the migration

```cmd
npx supabase db push
```

This applies the migration to your linked Supabase cloud project and records
it in `supabase_migrations.schema_migrations`.

**Gate:** Command exits with no errors. Note the success message — it will
say something like `Applied 1 migration`.

---

## Step 5 — Verify in the Supabase dashboard

Open your Supabase project in the browser and confirm each of the following:

1. Go to **Table Editor** — all five tables appear:
   `documents`, `chunks`, `conversations`, `messages`, `message_sources`

2. Click **chunks** → inspect the columns. Confirm:
   - `embedding` column exists with type `vector(1536)`

3. Go to **Database → Indexes**. Confirm:
   - `chunks_embedding_hnsw_idx` exists with method `hnsw`

4. Go to **Authentication → Policies**. Confirm:
   - All five tables show RLS as **enabled**
   - Each table has the expected number of policies (documents: 4,
     chunks: 3, conversations: 4, messages: 3, message_sources: 3)

**Gate:** All four dashboard checks pass.

---

## Step 6 — RLS isolation test

This is the most important gate. Test that RLS actually blocks cross-user
access. You will do this using the Supabase **SQL editor** (read-only
verification — you are not making schema changes, just running test queries).

Open **SQL Editor** in the Supabase dashboard and run:

```sql
-- Confirm RLS is enabled on all tables
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('documents', 'chunks', 'conversations', 'messages', 'message_sources')
order by tablename;
```

Every row should show `rowsecurity = true`.

```sql
-- Confirm all policies exist
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

You should see all 17 policies listed (4 + 3 + 4 + 3 + 3).

**Gate:** Both queries return the expected results.

---

## Step 7 — Commit the migration file

The migration file is the source of truth for the schema. Commit it now so
it is in version control before Phase 2 begins.

```cmd
git add supabase\migrations\
git commit -m "feat: initial database schema with pgvector and RLS"
```

**Gate:** `git log --oneline -1` shows the commit.

---

## Phase 1 completion checklist

Before declaring Phase 1 done, confirm all of the following:

- [ ] `npx supabase db push --dry-run` ran with no SQL errors
- [ ] `npx supabase db push` applied 1 migration successfully
- [ ] All five tables visible in the Supabase Table Editor
- [ ] `chunks.embedding` column is `vector(1536)`
- [ ] HNSW index `chunks_embedding_hnsw_idx` exists
- [ ] RLS is enabled on all five tables (dashboard + SQL query confirm)
- [ ] All 17 RLS policies exist (SQL query confirms)
- [ ] Migration file committed to git

**Do not begin Phase 2 (Auth & the BFF guard) until every box is checked.**

---

## Key design decisions (document in README later)

- **`user_id` denormalised onto `chunks`:** avoids a join back to `documents`
  on every vector query; RLS stays a simple equality check.
- **HNSW over IVFFlat:** no pre-training step needed, better recall/latency,
  works well from zero rows. `vector_cosine_ops` matches the `<=>` cosine
  distance operator used in retrieval.
- **Embedding dimension fixed at 1536:** matches `text-embedding-3-small`.
  Swapping to a different embedding model/dimension requires a migration to
  ALTER the `chunks.embedding` column and re-embed all content.
- **`(select auth.uid())` pattern:** wrapping in a subquery allows Postgres
  to cache the result per statement rather than calling the function on every
  row — per current Supabase RLS performance guidance.
- **`message_sources.sentence_text` stored resolved:** citations survive
  document edits and re-chunking because the sentence text is stored at
  answer time, not derived on read.
- **Single migration file:** the entire schema in one file for Phase 1.
  Subsequent phases add new migrations; this file is never modified after push.

---

## Explicitly out of scope for Phase 1

- Auth UI, sign-in/sign-up pages (Phase 2)
- NestJS AuthGuard or Supabase client wiring (Phase 2)
- Document CRUD endpoints or UI (Phase 3)
- Embedding or chunking logic (Phase 5)
- Any application code changes
