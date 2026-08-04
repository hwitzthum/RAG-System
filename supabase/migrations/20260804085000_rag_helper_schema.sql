-- Move this app's internal SQL helpers out of the shared `public` schema.
--
-- This database is not ours alone. Rezeptmeister (github.com/hwitzthum/Rezeptmeister)
-- keeps its tables in the same `public` schema of this same project and manages
-- them with Alembic, entirely independently of supabase/migrations/. Two
-- migration systems writing to one namespace means a name chosen by either side
-- can silently replace the other's object: `create or replace function` does not
-- warn, it just overwrites.
--
-- `build_keyword_tsquery(regconfig, text)` and
-- `language_text_search_config(supported_language)` are generic enough that an
-- Alembic revision could plausibly define the same names. They are also purely
-- internal — nothing outside the database calls them; they exist only to serve
-- `document_chunks_set_tsv` and `search_document_chunks_keyword`. So they do not
-- belong in a shared namespace at all.
--
-- What deliberately STAYS in `public`:
--   - match_document_chunks, search_document_chunks_keyword and the other RPCs
--     the application invokes through supabase.rpc(). PostgREST only exposes
--     schemas listed in the project's API settings (`public` here), so moving
--     these would break every call site. Their names are also app-specific
--     enough to be low collision risk.
--
-- The `rag` schema is intentionally NOT added to the PostgREST exposed-schema
-- list: these helpers should never be reachable over the REST API.
--
-- ALTER ... SET SCHEMA is used rather than create-new-then-drop-old so the
-- function definitions cannot drift from what is already running. The callers
-- are re-created in the same migration, and Supabase applies each migration in
-- a transaction, so there is no window in which a caller references a function
-- that has moved.

create schema if not exists rag;

comment on schema rag is
  'Internal helpers for the RAG application. Not exposed to PostgREST. Kept out of public because this database is shared with a second application whose schema is managed independently (Alembic).';

-- ---------------------------------------------------------------------------
-- Relocate the helpers
-- ---------------------------------------------------------------------------

alter function public.language_text_search_config(public.supported_language)
  set schema rag;

alter function public.build_keyword_tsquery(regconfig, text)
  set schema rag;

-- ---------------------------------------------------------------------------
-- Re-point the two callers at the new schema
-- ---------------------------------------------------------------------------

-- Body unchanged apart from the schema qualification on the helper call.
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

  language_config := rag.language_text_search_config(new.language);

  -- Union of exact tokens and stemmed tokens. Keeping the 'simple' half means
  -- every match that worked before still works; the language half only adds
  -- recall.
  new.tsv := to_tsvector('simple'::regconfig, source_text)
          || to_tsvector(language_config, source_text);

  return new;
end;
$$;

-- Body unchanged apart from the schema qualification on the helper calls.
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
      rag.build_keyword_tsquery('simple'::regconfig, query_text)
      || rag.build_keyword_tsquery('english'::regconfig, query_text)
      || rag.build_keyword_tsquery('german'::regconfig, query_text)
      || rag.build_keyword_tsquery('french'::regconfig, query_text)
      || rag.build_keyword_tsquery('italian'::regconfig, query_text)
      || rag.build_keyword_tsquery('spanish'::regconfig, query_text) as tsq
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
-- Grants
-- ---------------------------------------------------------------------------

-- Both callers are SECURITY INVOKER, so the invoking role needs to reach into
-- the new schema. Usage on the schema alone exposes nothing: there is no table
-- here, and the schema is not published over the REST API.
grant usage on schema rag to authenticated, service_role;

grant execute on function rag.language_text_search_config(public.supported_language)
  to authenticated, service_role;

grant execute on function rag.build_keyword_tsquery(regconfig, text)
  to authenticated, service_role;

grant execute on function public.search_document_chunks_keyword(text, integer, uuid[])
  to authenticated, service_role;
