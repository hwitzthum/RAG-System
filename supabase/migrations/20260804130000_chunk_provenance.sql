-- Chunk provenance: record how each chunk's text was extracted, which
-- embedding model produced its vector, and its (approximate) token count.
--
-- Motivation: the ingestion pipeline previously wrote chunks with no way to
-- tell a byte-scrape-fallback extraction from a clean pdfjs one, or to detect
-- embedding-model drift per chunk. All columns are nullable and additive;
-- chunks written before this migration simply carry NULLs until re-ingested.

ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS extraction_method text,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS token_count integer;

COMMENT ON COLUMN public.document_chunks.extraction_method IS
  'How the source text was extracted: pdfjs | byte_scrape. NULL for chunks ingested before provenance tracking.';
COMMENT ON COLUMN public.document_chunks.embedding_model IS
  'Embedding model and dimensions that produced this chunk''s vector, as "<model>@<dims>". NULL for pre-provenance chunks.';
COMMENT ON COLUMN public.document_chunks.token_count IS
  'Token count of the chunk content as measured by the ingestion chunker. NULL for pre-provenance chunks.';

-- replace_document_chunks: same contract as 202603130024, plus the three
-- provenance fields parsed from each chunk object (all optional).
CREATE OR REPLACE FUNCTION public.replace_document_chunks(
  target_document_id uuid,
  target_chunks jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (
  document_id uuid,
  deleted_chunk_count bigint,
  inserted_chunk_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted_chunks AS (
    DELETE FROM public.document_chunks
    WHERE document_id = target_document_id
    RETURNING id
  ),
  parsed_chunks AS (
    SELECT
      COALESCE((chunk_value->>'chunk_index')::integer, ordinality::integer - 1) AS chunk_index,
      COALESCE((chunk_value->>'page_number')::integer, 1) AS page_number,
      NULLIF(chunk_value->>'section_title', '') AS section_title,
      COALESCE(chunk_value->>'content', '') AS content,
      COALESCE(chunk_value->>'context', '') AS context,
      COALESCE((chunk_value->>'language')::public.supported_language, 'EN'::public.supported_language) AS language,
      COALESCE(
        (
          SELECT
            '[' || string_agg(value_text, ',' ORDER BY embedding_ordinality) || ']'
          FROM jsonb_array_elements_text(COALESCE(chunk_value->'embedding', '[]'::jsonb))
            WITH ORDINALITY AS embedding_values(value_text, embedding_ordinality)
        ),
        '[]'
      )::vector AS embedding,
      NULLIF(chunk_value->>'extraction_method', '') AS extraction_method,
      NULLIF(chunk_value->>'embedding_model', '') AS embedding_model,
      (chunk_value->>'token_count')::integer AS token_count
    FROM jsonb_array_elements(COALESCE(target_chunks, '[]'::jsonb)) WITH ORDINALITY AS chunk_rows(chunk_value, ordinality)
  ),
  inserted_chunks AS (
    INSERT INTO public.document_chunks (
      document_id,
      chunk_index,
      page_number,
      section_title,
      content,
      context,
      language,
      embedding,
      extraction_method,
      embedding_model,
      token_count
    )
    SELECT
      target_document_id,
      pc.chunk_index,
      pc.page_number,
      pc.section_title,
      pc.content,
      pc.context,
      pc.language,
      pc.embedding,
      pc.extraction_method,
      pc.embedding_model,
      pc.token_count
    FROM parsed_chunks pc
    RETURNING id
  )
  SELECT
    target_document_id AS document_id,
    (SELECT count(*) FROM deleted_chunks) AS deleted_chunk_count,
    (SELECT count(*) FROM inserted_chunks) AS inserted_chunk_count;
$$;

REVOKE ALL ON FUNCTION public.replace_document_chunks(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.replace_document_chunks(uuid, jsonb) TO service_role;

-- append_document_chunks: same contract as 202603130026, plus provenance.
CREATE OR REPLACE FUNCTION public.append_document_chunks(
  target_document_id uuid,
  target_chunks jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (
  document_id uuid,
  inserted_chunk_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH parsed_chunks AS (
    SELECT
      COALESCE((chunk_value->>'chunk_index')::integer, ordinality::integer - 1) AS chunk_index,
      COALESCE((chunk_value->>'page_number')::integer, 1) AS page_number,
      NULLIF(chunk_value->>'section_title', '') AS section_title,
      COALESCE(chunk_value->>'content', '') AS content,
      COALESCE(chunk_value->>'context', '') AS context,
      COALESCE((chunk_value->>'language')::public.supported_language, 'EN'::public.supported_language) AS language,
      COALESCE(
        (
          SELECT
            '[' || string_agg(value_text, ',' ORDER BY embedding_ordinality) || ']'
          FROM jsonb_array_elements_text(COALESCE(chunk_value->'embedding', '[]'::jsonb))
            WITH ORDINALITY AS embedding_values(value_text, embedding_ordinality)
        ),
        '[]'
      )::vector AS embedding,
      NULLIF(chunk_value->>'extraction_method', '') AS extraction_method,
      NULLIF(chunk_value->>'embedding_model', '') AS embedding_model,
      (chunk_value->>'token_count')::integer AS token_count
    FROM jsonb_array_elements(COALESCE(target_chunks, '[]'::jsonb)) WITH ORDINALITY AS chunk_rows(chunk_value, ordinality)
  ),
  inserted_chunks AS (
    INSERT INTO public.document_chunks (
      document_id,
      chunk_index,
      page_number,
      section_title,
      content,
      context,
      language,
      embedding,
      extraction_method,
      embedding_model,
      token_count
    )
    SELECT
      target_document_id,
      pc.chunk_index,
      pc.page_number,
      pc.section_title,
      pc.content,
      pc.context,
      pc.language,
      pc.embedding,
      pc.extraction_method,
      pc.embedding_model,
      pc.token_count
    FROM parsed_chunks pc
    RETURNING id
  )
  SELECT
    target_document_id AS document_id,
    (SELECT count(*) FROM inserted_chunks) AS inserted_chunk_count;
$$;

REVOKE ALL ON FUNCTION public.append_document_chunks(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.append_document_chunks(uuid, jsonb) TO service_role;

-- Migration-time round-trip check: the updated RPC must persist and return
-- the provenance fields. Fails the migration loudly instead of shipping a
-- silently lossy parse list.
DO $$
DECLARE
  smoke_doc_id uuid;
  smoke_embedding jsonb := to_jsonb(ARRAY(SELECT 0.0::double precision FROM generate_series(1, 1024)));
  round_trip record;
BEGIN
  INSERT INTO public.documents (storage_path, sha256, title, status)
  VALUES (
    'migration-smoke/' || gen_random_uuid() || '.pdf',
    md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text),
    'Provenance Migration Smoke',
    'queued'
  )
  RETURNING id INTO smoke_doc_id;

  PERFORM public.replace_document_chunks(
    smoke_doc_id,
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'page_number', 1,
        'section_title', 'Smoke',
        'content', 'Provenance smoke content',
        'context', 'Provenance smoke context',
        'language', 'EN',
        'embedding', smoke_embedding,
        'extraction_method', 'pdfjs',
        'embedding_model', 'text-embedding-3-large@1024',
        'token_count', 3
      )
    )
  );

  SELECT extraction_method, embedding_model, token_count
  INTO round_trip
  FROM public.document_chunks
  WHERE document_id = smoke_doc_id
  LIMIT 1;

  IF round_trip.extraction_method IS DISTINCT FROM 'pdfjs'
     OR round_trip.embedding_model IS DISTINCT FROM 'text-embedding-3-large@1024'
     OR round_trip.token_count IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'chunk provenance round-trip failed: %', to_jsonb(round_trip);
  END IF;

  DELETE FROM public.document_chunks WHERE document_id = smoke_doc_id;
  DELETE FROM public.documents WHERE id = smoke_doc_id;
END;
$$;
