CREATE OR REPLACE FUNCTION public.requeue_dead_letter_document(target_document_id uuid)
RETURNS TABLE (
  document_id uuid,
  ingestion_job_id uuid,
  document_status public.document_status,
  job_status public.ingestion_job_status,
  ingestion_version integer,
  storage_path text,
  sha256 text,
  idempotency_key text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  requeue_timestamp timestamptz := now();
BEGIN
  RETURN QUERY
  WITH locked_document AS (
    SELECT d.id, d.storage_path, d.sha256, d.ingestion_version
    FROM public.documents d
    WHERE d.id = target_document_id
      AND d.status = 'failed'
    FOR UPDATE
  ),
  updated_document AS (
    UPDATE public.documents d
    SET
      status = 'queued',
      ingestion_version = ld.ingestion_version + 1,
      updated_at = requeue_timestamp
    FROM locked_document ld
    WHERE d.id = ld.id
    RETURNING d.id, d.status, d.ingestion_version, d.storage_path, d.sha256, d.updated_at
  ),
  inserted_job AS (
    INSERT INTO public.ingestion_jobs (
      document_id,
      status,
      attempt,
      idempotency_key,
      created_at,
      updated_at
    )
    SELECT
      ud.id,
      'queued'::public.ingestion_job_status,
      0,
      ud.sha256 || ':v' || ud.ingestion_version,
      requeue_timestamp,
      requeue_timestamp
    FROM updated_document ud
    RETURNING id, document_id, status, idempotency_key, updated_at
  )
  SELECT
    ud.id AS document_id,
    ij.id AS ingestion_job_id,
    ud.status AS document_status,
    ij.status AS job_status,
    ud.ingestion_version,
    ud.storage_path,
    ud.sha256,
    ij.idempotency_key,
    ij.updated_at
  FROM updated_document ud
  JOIN inserted_job ij ON ij.document_id = ud.id;
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_dead_letter_document(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.requeue_dead_letter_document(uuid) TO service_role;
