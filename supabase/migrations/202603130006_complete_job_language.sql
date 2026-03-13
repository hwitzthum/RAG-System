-- Allow completion to persist the detected document language atomically with
-- the job/document status transition.

DROP FUNCTION IF EXISTS public.complete_ingestion_job(uuid);

CREATE OR REPLACE FUNCTION public.complete_ingestion_job(
  job_id uuid,
  document_language public.supported_language DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  job_status public.ingestion_job_status,
  document_status public.document_status,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  completion_timestamp timestamptz := now();
BEGIN
  RETURN QUERY
  WITH completed_job AS (
    UPDATE public.ingestion_jobs ij
    SET
      status = 'completed',
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = completion_timestamp
    WHERE ij.id = job_id
      AND ij.status = 'processing'
    RETURNING ij.id, ij.document_id, ij.status, ij.updated_at
  ),
  updated_document AS (
    UPDATE public.documents d
    SET
      status = 'ready',
      language = COALESCE(document_language, d.language),
      updated_at = completion_timestamp
    FROM completed_job cj
    WHERE d.id = cj.document_id
    RETURNING d.id, d.status
  )
  SELECT
    cj.id,
    cj.document_id,
    cj.status AS job_status,
    ud.status AS document_status,
    cj.updated_at
  FROM completed_job cj
  JOIN updated_document ud ON ud.id = cj.document_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ingestion_job(uuid, public.supported_language) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_ingestion_job(uuid, public.supported_language) TO service_role;
