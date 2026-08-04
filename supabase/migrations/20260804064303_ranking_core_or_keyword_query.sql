-- Follow-up to 20260804063819_ranking_core.sql: OR-based keyword tsquery.
--
-- That migration ranked the keyword branch correctly but left it returning
-- almost nothing, because both plainto_tsquery (what the previous PostgREST
-- .textSearch call used) and websearch_to_tsquery combine their terms with AND.
-- A natural-language question therefore required every one of its content words
-- to appear in the same chunk:
--
--   websearch_to_tsquery('german', 'wie läuft der prozess für einen unterstützungsantrag ab')
--     => 'lauft' & 'prozess' & 'unterstutzungsantrag' & 'ab'   -- 0 rows
--
-- Measured against the live corpus that returned zero keyword candidates for
-- 7 of 8 realistic questions, which made "hybrid" retrieval vector-only in
-- practice. OR-ing the terms and letting ts_rank_cd order the matches is the
-- normal shape for ranked keyword retrieval.
--
-- Lexemes shorter than three characters are dropped. ts_rank_cd applies no IDF
-- weighting, so a short high-frequency particle ('ab', 'in', 'of') otherwise
-- scores as heavily as a rare content term and floats unrelated chunks to the
-- top — with 'ab' included, the correct chunk for the query above ranked third
-- behind an English chunk; without it, first.
--
-- Lexemes come out of to_tsvector already normalised, so the result is cast
-- straight to tsquery rather than passed back through to_tsquery, which would
-- run them through the stemmer a second time.

create or replace function public.build_keyword_tsquery(config regconfig, query_text text)
returns tsquery
language sql
immutable
as $$
  select coalesce(
    (
      select string_agg(quote_literal(lexeme), ' | ')
      from unnest(tsvector_to_array(to_tsvector(config, query_text))) as lexeme
      where length(lexeme) >= 3
    )::tsquery,
    ''::tsquery
  );
$$;

-- Same body as 20260804063819 apart from the tsquery construction: the six
-- per-configuration queries are still OR-ed together, so a German term stems
-- against German rows and an English term against English rows without the
-- caller having to guess the query's language first. build_keyword_tsquery
-- returns an empty tsquery when nothing survives, and ''::tsquery || 'x'::tsquery
-- collapses to 'x', so OR-ing them is safe.
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
      public.build_keyword_tsquery('simple'::regconfig, query_text)
      || public.build_keyword_tsquery('english'::regconfig, query_text)
      || public.build_keyword_tsquery('german'::regconfig, query_text)
      || public.build_keyword_tsquery('french'::regconfig, query_text)
      || public.build_keyword_tsquery('italian'::regconfig, query_text)
      || public.build_keyword_tsquery('spanish'::regconfig, query_text) as tsq
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

grant execute on function public.build_keyword_tsquery(regconfig, text)
  to authenticated, service_role;

grant execute on function public.search_document_chunks_keyword(text, integer, uuid[])
  to authenticated, service_role;
