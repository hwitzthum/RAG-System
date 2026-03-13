-- Recreate claim_ingestion_jobs with a dead-letter guard.
-- When reclaiming a stale-locked job, if attempt >= max_retries the job
-- is dead-lettered instead of reclaimed, preventing infinite retry loops
-- when Vercel kills functions before markJobFailed can run.

DROP FUNCTION IF EXISTS public.claim_ingestion_jobs(text, integer, integer);

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
  -- Step 1: Dead-letter stale-locked jobs that exceeded max retries
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
      updated_at = claim_timestamp
    FROM stale_to_dead_letter sdl
    WHERE ij.id = sdl.id
    RETURNING ij.document_id
  )
  UPDATE public.documents d
  SET status = 'failed', updated_at = claim_timestamp
  FROM dead_lettered dl
  WHERE d.id = dl.document_id;

  -- Step 2: Claim eligible jobs (queued/failed unlocked, or stale processing under retry limit)
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

REVOKE ALL ON FUNCTION public.claim_ingestion_jobs(text, integer, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_jobs(text, integer, integer, integer) TO service_role;
