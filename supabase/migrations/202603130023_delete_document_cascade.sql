CREATE OR REPLACE FUNCTION public.delete_document_cascade(target_document_id uuid)
RETURNS TABLE (
  document_id uuid,
  storage_path text,
  deleted_job_count bigint,
  deleted_chunk_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted_jobs AS (
    DELETE FROM public.ingestion_jobs
    WHERE document_id = target_document_id
    RETURNING id
  ),
  deleted_chunks AS (
    DELETE FROM public.document_chunks
    WHERE document_id = target_document_id
    RETURNING id
  ),
  deleted_document AS (
    DELETE FROM public.documents
    WHERE id = target_document_id
    RETURNING id, storage_path
  )
  SELECT
    dd.id AS document_id,
    dd.storage_path,
    (SELECT count(*) FROM deleted_jobs) AS deleted_job_count,
    (SELECT count(*) FROM deleted_chunks) AS deleted_chunk_count
  FROM deleted_document dd;
$$;

REVOKE ALL ON FUNCTION public.delete_document_cascade(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_document_cascade(uuid) TO service_role;
