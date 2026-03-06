-- Phase 7 retrieval helpers

create or replace function public.match_document_chunks(
  query_embedding vector(1536),
  match_count integer default 20,
  filter_language public.supported_language default null
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
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

grant execute on function public.match_document_chunks(vector, integer, public.supported_language)
  to authenticated, service_role;
