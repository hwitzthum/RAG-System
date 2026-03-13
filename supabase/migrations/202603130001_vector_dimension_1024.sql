-- Switch embedding dimension from 1536 to 1024 for text-embedding-3-large with
-- Matryoshka dimensionality reduction. Existing chunks must be re-embedded.

-- Clear existing chunks (they are 1536-dim, incompatible with 1024-dim column)
DELETE FROM public.document_chunks;

-- Reset documents to queued so they get re-ingested with new dimensions
UPDATE public.documents SET status = 'queued';

-- Invalidate retrieval cache
TRUNCATE public.retrieval_cache;

-- Drop old IVFFlat index before altering column type
DROP INDEX IF EXISTS idx_document_chunks_embedding_ivfflat;

-- Alter embedding column to vector(1024)
ALTER TABLE public.document_chunks ALTER COLUMN embedding TYPE vector(1024);

-- Recreate IVFFlat cosine index
CREATE INDEX idx_document_chunks_embedding_ivfflat
  ON public.document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Recreate match_document_chunks RPC with vector(1024) parameter
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
