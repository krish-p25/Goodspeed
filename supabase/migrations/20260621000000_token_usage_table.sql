-- =============================================================================
-- Migration: token_usage_table
-- Purpose: Persist token usage for every LLM call (chat and embedding).
--          One row per call. Aggregated and charted in the dashboard.
--
-- Note: timestamp deliberately ordered AFTER the initial schema
-- (20260618) and match_chunks function (20260619) so the foreign keys to
-- conversations / messages resolve when migrations apply in order.
-- =============================================================================

create table public.token_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,

  -- Discriminator: which kind of LLM call this row represents
  type              text not null check (type in ('chat', 'embedding')),

  -- Chat-specific fields (null for embedding rows)
  conversation_id   uuid references public.conversations(id) on delete set null,
  message_id        uuid references public.messages(id) on delete set null,
  prompt_tokens     integer,
  completion_tokens integer,

  -- Shared: total tokens for this call
  -- For chat: prompt_tokens + completion_tokens
  -- For embedding: total tokens across all texts embedded in the batch
  total_tokens      integer not null default 0,

  -- Which model was used
  model             text,

  created_at        timestamptz not null default now()
);

-- Index for per-user aggregation queries (primary access pattern)
create index token_usage_user_id_idx
  on public.token_usage using btree (user_id);

-- Index for date-range queries
create index token_usage_created_at_idx
  on public.token_usage using btree (created_at);

-- Composite index for the dashboard query: user + date range + type
create index token_usage_user_created_type_idx
  on public.token_usage using btree (user_id, created_at, type);

-- RLS
alter table public.token_usage enable row level security;

create policy "token_usage: users can select own rows"
  on public.token_usage for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "token_usage: users can insert own rows"
  on public.token_usage for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
