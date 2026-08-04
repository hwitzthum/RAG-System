-- Ranking core fixes.
--
-- Three defects in the retrieval ranking path, all at the database layer:
--
-- 1. document_chunks.tsv was built with to_tsvector('simple', ...), which does
--    no stemming in any language. On a corpus that is majority German this
--    means "Verträge" never matches "Vertrag". The tsv is now the union of the
--    'simple' vector (exact tokens, preserving today's behaviour so nothing
--    can regress) and a vector built with the stemmer for the chunk's own
--    language.
--
-- 2. The keyword half of "hybrid retrieval" was issued from PostgREST as
--    .textSearch(...).limit(n) with no ts_rank and no ORDER BY, so rows came
--    back in whatever order Postgres produced them. lib/retrieval/rrf.ts then
--    assigns each candidate its RRF rank from its array position — meaning the
--    keyword branch contributed essentially random ranks to the fusion. The
--    new search_document_chunks_keyword RPC ranks with ts_rank_cd and returns
--    the score, so fusion has a real ranked list on both sides.
--
-- 3. idx_document_chunks_embedding_ivfflat was created by
--    202603130001_vector_dimension_1024.sql immediately after that migration's
--    "DELETE FROM public.document_chunks" — i.e. against an empty table. IVFFlat
--    assigns its centroids at build time, so the index was never trained on
--    real vectors. Combined with lists=100 over a few hundred live rows and
--    ivfflat.probes left at its default of 1, vector recall was badly degraded.
--    HNSW does not have a training step, degrades gracefully at any table size,
--    and is available on this project (pgvector 0.8.0).

-- ---------------------------------------------------------------------------
-- 1. Language -> text search configuration
-- ---------------------------------------------------------------------------

create or replace function public.language_text_search_config(lang public.supported_language)
returns regconfig
language sql
immutable
as $$
  select case lang
    when 'DE' then 'german'
    when 'FR' then 'french'
    when 'IT' then 'italian'
    when 'ES' then 'spanish'
    else 'english'
  end::regconfig;
$$;

-- ---------------------------------------------------------------------------
-- 2. Stemmed, language-aware tsv
-- ---------------------------------------------------------------------------

create or replace function public.document_chunks_set_tsv()
returns trigger
language plpgsql
as $$
declare
  source_text text;
  language_config regconfig;
begin
  source_text :=
    coalesce(new.section_title, '') || ' ' ||
    coalesce(new.content, '') || ' ' ||
    coalesce(new.context, '');

  language_config := public.language_text_search_config(new.language);

  -- Union of exact tokens and stemmed tokens. Keeping the 'simple' half means
  -- every match that worked before still works; the language half only adds
  -- recall.
  new.tsv := to_tsvector('simple'::regconfig, source_text)
          || to_tsvector(language_config, source_text);

  return new;
end;
$$;

-- Rebuild tsv for existing rows through the trigger above. This is a no-op
-- write that fires BEFORE UPDATE; document_chunks has no updated_at column, so
-- nothing else changes.
update public.document_chunks set language = language;

-- ---------------------------------------------------------------------------
-- 3. Ranked keyword retrieval
-- ---------------------------------------------------------------------------

-- The tsquery is the OR of every supported configuration, so a German query
-- term stems against German rows and an English term against English rows
-- without the caller having to guess the query's language first (which it
-- cannot do reliably for short queries).
--
-- NOTE: websearch_to_tsquery combines the terms *within* each configuration
-- with AND. Measured against the live corpus this returned zero keyword
-- candidates for 7 of 8 realistic questions; 20260804064303 replaces this with
-- an OR-based builder. Kept here as applied so a fresh database replays the
-- same history.
create or replace function public.search_document_chunks_keyword(
  query_text text,
  match_count integer default 20,
  filter_document_ids uuid[] default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  page_number integer,
  section_title text,
  content text,
  context text,
  language public.supported_language,
  rank double precision
)
language sql
stable
as $$
  with parsed_query as (
    select
      websearch_to_tsquery('simple'::regconfig, query_text)
      || websearch_to_tsquery('english'::regconfig, query_text)
      || websearch_to_tsquery('german'::regconfig, query_text)
      || websearch_to_tsquery('french'::regconfig, query_text)
      || websearch_to_tsquery('italian'::regconfig, query_text)
      || websearch_to_tsquery('spanish'::regconfig, query_text) as tsq
  )
  select
    dc.id as chunk_id,
    dc.document_id,
    dc.page_number,
    dc.section_title,
    dc.content,
    dc.context,
    dc.language,
    ts_rank_cd(dc.tsv, parsed_query.tsq)::double precision as rank
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  cross join parsed_query
  where d.status = 'ready'
    and (filter_document_ids is null or dc.document_id = any(filter_document_ids))
    and dc.tsv @@ parsed_query.tsq
  -- dc.id breaks ties deterministically so repeated identical queries return a
  -- stable order (RRF consumes ordinal position, so instability would move
  -- fused scores between runs).
  order by ts_rank_cd(dc.tsv, parsed_query.tsq) desc, dc.id
  limit greatest(match_count, 1);
$$;

-- ---------------------------------------------------------------------------
-- 4. HNSW vector index
-- ---------------------------------------------------------------------------

drop index if exists public.idx_document_chunks_embedding_ivfflat;

create index if not exists idx_document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- 5. match_document_chunks
-- ---------------------------------------------------------------------------

-- Body is unchanged from 202603130003. The only difference is the per-function
-- hnsw.ef_search setting: ef_search must be at least the requested LIMIT or the
-- index returns fewer candidates than asked for, and the application requests
-- up to RAG_RERANK_POOL_SIZE (40 by default) candidates per search. The
-- default ef_search of 40 leaves no headroom, so it is raised here rather than
-- set database-wide.
--
-- filter_language is retained in the signature for compatibility with
-- lib/supabase/database.types.ts and the earlier migrations that granted this
-- exact signature. The application now always passes null: text-embedding-3-large
-- is multilingual, so partitioning the search by a heuristically detected query
-- language discarded recall for no gain. Language is applied as a ranking
-- signal instead (see lib/retrieval/reranker.ts).
create or replace function public.match_document_chunks(
  query_embedding vector(1024),
  match_count integer default 20,
  filter_language public.supported_language default null,
  filter_document_ids uuid[] default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  page_number integer,
  section_title text,
  content text,
  context text,
  language public.supported_language,
  similarity double precision
)
language sql
stable
set hnsw.ef_search = '120'
as $$
  select
    dc.id as chunk_id,
    dc.document_id,
    dc.page_number,
    dc.section_title,
    dc.content,
    dc.context,
    dc.language,
    (1 - (dc.embedding <=> query_embedding))::double precision as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where d.status = 'ready'
    and (filter_language is null or dc.language = filter_language)
    and (filter_document_ids is null or dc.document_id = any(filter_document_ids))
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

grant execute on function public.language_text_search_config(public.supported_language)
  to authenticated, service_role;

grant execute on function public.search_document_chunks_keyword(text, integer, uuid[])
  to authenticated, service_role;

grant execute on function public.match_document_chunks(vector, integer, public.supported_language, uuid[])
  to authenticated, service_role;
