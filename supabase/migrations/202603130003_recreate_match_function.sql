-- Recreate match_document_chunks after dropping all overloads in the previous migration.
-- PostgreSQL treats vector(1024) and vector(1536) as the same base type, so the
-- targeted DROP also removed the correct version.

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding vector(1024),
  match_count integer DEFAULT 20,
  filter_language public.supported_language DEFAULT NULL,
  filter_document_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  page_number integer,
  section_title text,
  content text,
  context text,
  language public.supported_language,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    dc.id AS chunk_id,
    dc.document_id,
    dc.page_number,
    dc.section_title,
    dc.content,
    dc.context,
    dc.language,
    (1 - (dc.embedding <=> query_embedding))::double precision AS similarity
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE d.status = 'ready'
    AND (filter_language IS NULL OR dc.language = filter_language)
    AND (filter_document_ids IS NULL OR dc.document_id = ANY(filter_document_ids))
  ORDER BY dc.embedding <=> query_embedding
  LIMIT greatest(match_count, 1);
$$;

GRANT EXECUTE ON FUNCTION public.match_document_chunks(vector, integer, public.supported_language, uuid[])
  TO authenticated, service_role;
