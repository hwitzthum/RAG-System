ALTER TABLE public.ingestion_jobs
ADD COLUMN IF NOT EXISTS current_stage text,
ADD COLUMN IF NOT EXISTS stage_updated_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_ingestion_jobs(
  worker_name text,
  batch_size integer DEFAULT 1,
  lock_timeout_seconds integer DEFAULT 900,
  max_retries integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  status public.ingestion_job_status,
  attempt integer,
  last_error text,
  idempotency_key text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized_worker_name text := coalesce(nullif(worker_name, ''), 'vercel-ingestion-runner');
  normalized_batch_size integer := greatest(coalesce(batch_size, 1), 1);
  normalized_lock_timeout integer := greatest(coalesce(lock_timeout_seconds, 900), 1);
  normalized_max_retries integer := greatest(coalesce(max_retries, 3), 1);
  claim_timestamp timestamptz := now();
  stale_lock_cutoff timestamptz := claim_timestamp - make_interval(secs => normalized_lock_timeout);
BEGIN
  WITH stale_to_dead_letter AS (
    SELECT ij.id, ij.document_id
    FROM public.ingestion_jobs ij
    WHERE ij.status = 'processing'
      AND ij.locked_at IS NOT NULL
      AND ij.locked_at <= stale_lock_cutoff
      AND ij.attempt >= normalized_max_retries
    FOR UPDATE SKIP LOCKED
  ),
  dead_lettered AS (
    UPDATE public.ingestion_jobs ij
    SET
      status = 'dead_letter',
      last_error = 'Exceeded max retries (' || normalized_max_retries || ') with stale lock',
      locked_at = NULL,
      locked_by = NULL,
      current_stage = 'dead_letter',
      stage_updated_at = claim_timestamp,
      processing_duration_ms = coalesce(ij.processing_duration_ms, 0) + greatest(
        0,
        floor(extract(epoch FROM (claim_timestamp - coalesce(ij.processing_started_at, ij.locked_at, claim_timestamp))) * 1000)
      )::bigint,
      processing_started_at = NULL,
      updated_at = claim_timestamp
    FROM stale_to_dead_letter sdl
    WHERE ij.id = sdl.id
    RETURNING ij.document_id
  )
  UPDATE public.documents d
  SET status = 'failed', updated_at = claim_timestamp
  FROM dead_lettered dl
  WHERE d.id = dl.document_id;

  RETURN QUERY
  WITH candidate_jobs AS (
    SELECT ij.id
    FROM public.ingestion_jobs ij
    WHERE
      (
        ij.status IN ('queued', 'failed')
        AND ij.locked_at IS NULL
      )
      OR (
        ij.status = 'processing'
        AND ij.locked_at IS NOT NULL
        AND ij.locked_at <= stale_lock_cutoff
        AND ij.attempt < normalized_max_retries
      )
    ORDER BY ij.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT normalized_batch_size
  ),
  claimed_jobs AS (
    UPDATE public.ingestion_jobs ij
    SET
      status = 'processing',
      attempt = ij.attempt + 1,
      locked_at = claim_timestamp,
      locked_by = normalized_worker_name,
      current_stage = 'claimed',
      stage_updated_at = claim_timestamp,
      processing_duration_ms = CASE
        WHEN ij.status = 'processing' AND ij.locked_at IS NOT NULL THEN
          coalesce(ij.processing_duration_ms, 0) + greatest(
            0,
            floor(extract(epoch FROM (claim_timestamp - coalesce(ij.processing_started_at, ij.locked_at, claim_timestamp))) * 1000)
          )::bigint
        ELSE ij.processing_duration_ms
      END,
      processing_started_at = claim_timestamp,
      updated_at = claim_timestamp
    FROM candidate_jobs cj
    WHERE ij.id = cj.id
    RETURNING
      ij.id,
      ij.document_id,
      ij.status,
      ij.attempt,
      ij.last_error,
      ij.idempotency_key,
      ij.locked_at,
      ij.locked_by,
      ij.created_at,
      ij.updated_at
  ),
  touched_documents AS (
    UPDATE public.documents d
    SET
      status = 'processing',
      updated_at = claim_timestamp
    FROM claimed_jobs cj
    WHERE d.id = cj.document_id
      AND d.status <> 'processing'
    RETURNING d.id
  )
  SELECT
    cj.id,
    cj.document_id,
    cj.status,
    cj.attempt,
    cj.last_error,
    cj.idempotency_key,
    cj.locked_at,
    cj.locked_by,
    cj.created_at,
    cj.updated_at
  FROM claimed_jobs cj
  ORDER BY cj.created_at ASC;
END;
$$;

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
      current_stage = 'completed',
      stage_updated_at = completion_timestamp,
      processing_duration_ms = coalesce(ij.processing_duration_ms, 0) + greatest(
        0,
        floor(extract(epoch FROM (completion_timestamp - coalesce(ij.processing_started_at, ij.locked_at, completion_timestamp))) * 1000)
      )::bigint,
      processing_started_at = NULL,
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

CREATE OR REPLACE FUNCTION public.fail_ingestion_job(
  job_id uuid,
  error_text text,
  max_retries integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  job_status public.ingestion_job_status,
  attempt integer,
  dead_letter boolean,
  document_status public.document_status,
  last_error text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  failure_timestamp timestamptz := now();
  normalized_max_retries integer := greatest(coalesce(max_retries, 1), 1);
BEGIN
  RETURN QUERY
  WITH failed_job AS (
    UPDATE public.ingestion_jobs ij
    SET
      status = CASE
        WHEN ij.attempt >= normalized_max_retries THEN 'dead_letter'::public.ingestion_job_status
        ELSE 'failed'::public.ingestion_job_status
      END,
      last_error = left(coalesce(error_text, 'unknown_error'), 4000),
      locked_at = NULL,
      locked_by = NULL,
      current_stage = CASE
        WHEN ij.attempt >= normalized_max_retries THEN 'dead_letter'
        ELSE 'failed'
      END,
      stage_updated_at = failure_timestamp,
      processing_duration_ms = coalesce(ij.processing_duration_ms, 0) + greatest(
        0,
        floor(extract(epoch FROM (failure_timestamp - coalesce(ij.processing_started_at, ij.locked_at, failure_timestamp))) * 1000)
      )::bigint,
      processing_started_at = NULL,
      updated_at = failure_timestamp
    WHERE ij.id = job_id
      AND ij.status = 'processing'
    RETURNING ij.id, ij.document_id, ij.status, ij.attempt, ij.last_error, ij.updated_at
  ),
  updated_document AS (
    UPDATE public.documents d
    SET
      status = CASE
        WHEN fj.status = 'dead_letter' THEN 'failed'::public.document_status
        ELSE 'queued'::public.document_status
      END,
      updated_at = failure_timestamp
    FROM failed_job fj
    WHERE d.id = fj.document_id
    RETURNING d.id, d.status
  )
  SELECT
    fj.id,
    fj.document_id,
    fj.status AS job_status,
    fj.attempt,
    (fj.status = 'dead_letter') AS dead_letter,
    ud.status AS document_status,
    fj.last_error,
    fj.updated_at
  FROM failed_job fj
  JOIN updated_document ud ON ud.id = fj.document_id;
END;
$$;

DROP FUNCTION IF EXISTS public.checkpoint_ingestion_job(uuid, jsonb, integer, integer);

CREATE OR REPLACE FUNCTION public.checkpoint_ingestion_job(
  target_job_id uuid,
  target_chunk_candidates jsonb DEFAULT NULL,
  target_chunks_total integer DEFAULT NULL,
  target_chunks_processed integer DEFAULT NULL,
  target_stage text DEFAULT NULL
)
RETURNS TABLE (
  job_id uuid,
  chunks_total integer,
  chunks_processed integer,
  current_stage text,
  stage_updated_at timestamptz,
  locked_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ingestion_jobs ij
  SET
    chunk_candidates = COALESCE(target_chunk_candidates, ij.chunk_candidates),
    chunks_total = COALESCE(target_chunks_total, ij.chunks_total),
    chunks_processed = COALESCE(target_chunks_processed, ij.chunks_processed),
    current_stage = COALESCE(target_stage, ij.current_stage),
    stage_updated_at = CASE
      WHEN target_stage IS NOT NULL AND target_stage IS DISTINCT FROM ij.current_stage THEN now()
      WHEN ij.stage_updated_at IS NULL THEN now()
      ELSE ij.stage_updated_at
    END,
    locked_at = now(),
    updated_at = now()
  WHERE ij.id = target_job_id
    AND ij.status = 'processing'
  RETURNING ij.id AS job_id, ij.chunks_total, ij.chunks_processed, ij.current_stage, ij.stage_updated_at, ij.locked_at, ij.updated_at;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_ingestion_job(uuid, jsonb, integer, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.checkpoint_ingestion_job(uuid, jsonb, integer, integer, text) TO service_role;

DROP FUNCTION IF EXISTS public.yield_ingestion_job(uuid);

CREATE OR REPLACE FUNCTION public.yield_ingestion_job(target_job_id uuid)
RETURNS TABLE (
  job_id uuid,
  job_status public.ingestion_job_status,
  attempt integer,
  current_stage text,
  locked_at timestamptz,
  locked_by text,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ingestion_jobs ij
  SET
    status = 'queued'::public.ingestion_job_status,
    locked_at = NULL,
    locked_by = NULL,
    attempt = 0,
    current_stage = 'yielded',
    stage_updated_at = now(),
    updated_at = now()
  WHERE ij.id = target_job_id
    AND ij.status = 'processing'
  RETURNING ij.id AS job_id, ij.status AS job_status, ij.attempt, ij.current_stage, ij.locked_at, ij.locked_by, ij.updated_at;
$$;

REVOKE ALL ON FUNCTION public.yield_ingestion_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.yield_ingestion_job(uuid) TO service_role;
