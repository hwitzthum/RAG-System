CREATE OR REPLACE FUNCTION public.create_document_with_ingestion_job(
  target_storage_path text,
  target_sha256 text,
  target_title text DEFAULT NULL,
  target_language public.supported_language DEFAULT NULL
)
RETURNS TABLE (
  document_id uuid,
  ingestion_job_id uuid,
  document_status public.document_status,
  job_status public.ingestion_job_status,
  ingestion_version integer,
  storage_path text,
  sha256 text,
  idempotency_key text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH inserted_document AS (
    INSERT INTO public.documents (
      storage_path,
      sha256,
      title,
      language,
      status,
      ingestion_version
    )
    VALUES (
      target_storage_path,
      target_sha256,
      target_title,
      target_language,
      'queued'::public.document_status,
      1
    )
    ON CONFLICT (sha256) DO NOTHING
    RETURNING id, status, ingestion_version, storage_path, sha256, created_at
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
      d.id,
      'queued'::public.ingestion_job_status,
      0,
      d.sha256 || ':v' || d.ingestion_version,
      d.created_at,
      d.created_at
    FROM inserted_document d
    RETURNING id, document_id, status, idempotency_key, created_at
  )
  SELECT
    d.id AS document_id,
    j.id AS ingestion_job_id,
    d.status AS document_status,
    j.status AS job_status,
    d.ingestion_version,
    d.storage_path,
    d.sha256,
    j.idempotency_key,
    d.created_at
  FROM inserted_document d
  JOIN inserted_job j ON j.document_id = d.id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_document_with_ingestion_job(text, text, text, public.supported_language) FROM public;
GRANT EXECUTE ON FUNCTION public.create_document_with_ingestion_job(text, text, text, public.supported_language) TO service_role;
