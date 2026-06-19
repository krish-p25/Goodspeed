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
