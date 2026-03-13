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
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
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
      updated_at = now()
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
      now(),
      now()
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
$$;

REVOKE ALL ON FUNCTION public.requeue_dead_letter_document(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.requeue_dead_letter_document(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_document_status(
  target_document_id uuid,
  expected_current_status public.document_status,
  target_status public.document_status
)
RETURNS TABLE (
  document_id uuid,
  previous_status public.document_status,
  document_status public.document_status,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated_document AS (
    UPDATE public.documents d
    SET
      status = target_status,
      updated_at = now()
    WHERE d.id = target_document_id
      AND d.status = expected_current_status
    RETURNING d.id, expected_current_status AS previous_status, d.status, d.updated_at
  )
  SELECT
    ud.id AS document_id,
    ud.previous_status,
    ud.status AS document_status,
    ud.updated_at
  FROM updated_document ud;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_ingestion_job_state(
  target_job_id uuid,
  expected_current_status public.ingestion_job_status,
  target_job_status public.ingestion_job_status,
  clear_lock boolean DEFAULT true,
  target_document_status public.document_status DEFAULT NULL,
  expected_document_current_status public.document_status DEFAULT NULL
)
RETURNS TABLE (
  job_id uuid,
  document_id uuid,
  previous_job_status public.ingestion_job_status,
  job_status public.ingestion_job_status,
  document_status public.document_status,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated_job AS (
    UPDATE public.ingestion_jobs ij
    SET
      status = target_job_status,
      locked_at = CASE WHEN clear_lock THEN NULL ELSE ij.locked_at END,
      locked_by = CASE WHEN clear_lock THEN NULL ELSE ij.locked_by END,
      updated_at = now()
    WHERE ij.id = target_job_id
      AND ij.status = expected_current_status
    RETURNING ij.id, ij.document_id, expected_current_status AS previous_job_status, ij.status, ij.updated_at
  ),
  updated_document AS (
    UPDATE public.documents d
    SET
      status = target_document_status,
      updated_at = now()
    FROM updated_job uj
    WHERE target_document_status IS NOT NULL
      AND d.id = uj.document_id
      AND (expected_document_current_status IS NULL OR d.status = expected_document_current_status)
    RETURNING d.id, d.status
  )
  SELECT
    uj.id AS job_id,
    uj.document_id,
    uj.previous_job_status,
    uj.status AS job_status,
    ud.status AS document_status,
    uj.updated_at
  FROM updated_job uj
  LEFT JOIN updated_document ud ON ud.id = uj.document_id;
$$;

REVOKE ALL ON FUNCTION public.reconcile_document_status(uuid, public.document_status, public.document_status) FROM public;
REVOKE ALL ON FUNCTION public.reconcile_ingestion_job_state(uuid, public.ingestion_job_status, public.ingestion_job_status, boolean, public.document_status, public.document_status) FROM public;
GRANT EXECUTE ON FUNCTION public.reconcile_document_status(uuid, public.document_status, public.document_status) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_ingestion_job_state(uuid, public.ingestion_job_status, public.ingestion_job_status, boolean, public.document_status, public.document_status) TO service_role;
