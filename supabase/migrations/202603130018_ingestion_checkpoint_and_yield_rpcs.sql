CREATE OR REPLACE FUNCTION public.check_required_ingestion_rpcs(
  required_functions text[] DEFAULT ARRAY[
    'claim_ingestion_jobs',
    'complete_ingestion_job',
    'fail_ingestion_job',
    'create_document_with_ingestion_job',
    'requeue_dead_letter_document',
    'reconcile_document_status',
    'reconcile_ingestion_job_state',
    'checkpoint_ingestion_job',
    'yield_ingestion_job',
    'smoke_test_ingestion_runtime_contract'
  ]
)
RETURNS TABLE (
  function_name text,
  is_present boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    required_name AS function_name,
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = required_name
    ) AS is_present
  FROM unnest(required_functions) AS required_name;
$$;

REVOKE ALL ON FUNCTION public.check_required_ingestion_rpcs(text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.check_required_ingestion_rpcs(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_ingestion_job(
  target_job_id uuid,
  target_chunk_candidates jsonb DEFAULT NULL,
  target_chunks_total integer DEFAULT NULL,
  target_chunks_processed integer DEFAULT NULL
)
RETURNS TABLE (
  job_id uuid,
  chunks_total integer,
  chunks_processed integer,
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
    locked_at = now(),
    updated_at = now()
  WHERE ij.id = target_job_id
    AND ij.status = 'processing'
  RETURNING ij.id AS job_id, ij.chunks_total, ij.chunks_processed, ij.locked_at, ij.updated_at;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_ingestion_job(uuid, jsonb, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.checkpoint_ingestion_job(uuid, jsonb, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.yield_ingestion_job(target_job_id uuid)
RETURNS TABLE (
  job_id uuid,
  job_status public.ingestion_job_status,
  attempt integer,
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
    updated_at = now()
  WHERE ij.id = target_job_id
    AND ij.status = 'processing'
  RETURNING ij.id AS job_id, ij.status AS job_status, ij.attempt, ij.locked_at, ij.locked_by, ij.updated_at;
$$;

REVOKE ALL ON FUNCTION public.yield_ingestion_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.yield_ingestion_job(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.smoke_test_ingestion_runtime_contract()
RETURNS TABLE (
  check_name text,
  detail text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  first_checksum text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  second_checksum text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  base_timestamp timestamptz := timestamptz '2000-01-01T00:00:00Z';
  created_one record;
  created_two record;
  claimed_one record;
  reclaimed_one record;
  claimed_two record;
  checkpointed_one record;
  yielded_one record;
  completed_one record;
  failed_two record;
  requeued_two record;
  reconciled_document record;
  reconciled_job record;
BEGIN
  SELECT *
  INTO created_one
  FROM public.create_document_with_ingestion_job(
    'smoke/' || first_checksum || '.pdf',
    first_checksum,
    'Runtime Contract Smoke 1',
    NULL
  )
  LIMIT 1;

  IF created_one.document_id IS NULL OR created_one.ingestion_job_id IS NULL THEN
    RAISE EXCEPTION 'create_document_with_ingestion_job returned no row';
  END IF;

  check_name := 'create_document_with_ingestion_job';
  detail := 'created queued document and job';
  RETURN NEXT;

  UPDATE public.documents
  SET created_at = base_timestamp, updated_at = base_timestamp
  WHERE id = created_one.document_id;

  UPDATE public.ingestion_jobs
  SET created_at = base_timestamp, updated_at = base_timestamp
  WHERE id = created_one.ingestion_job_id;

  SELECT *
  INTO claimed_one
  FROM public.claim_ingestion_jobs('__runtime_contract_smoke__', 1, 60, 3)
  LIMIT 1;

  IF claimed_one.id IS DISTINCT FROM created_one.ingestion_job_id THEN
    RAISE EXCEPTION 'claim_ingestion_jobs did not claim the smoke test job';
  END IF;

  check_name := 'claim_ingestion_jobs';
  detail := 'claimed the smoke test job';
  RETURN NEXT;

  SELECT *
  INTO checkpointed_one
  FROM public.checkpoint_ingestion_job(
    created_one.ingestion_job_id,
    '[]'::jsonb,
    2,
    1
  )
  LIMIT 1;

  IF checkpointed_one.job_id IS DISTINCT FROM created_one.ingestion_job_id
     OR checkpointed_one.chunks_total IS DISTINCT FROM 2
     OR checkpointed_one.chunks_processed IS DISTINCT FROM 1
     OR checkpointed_one.locked_at IS NULL THEN
    RAISE EXCEPTION 'checkpoint_ingestion_job did not checkpoint the smoke test job';
  END IF;

  check_name := 'checkpoint_ingestion_job';
  detail := 'checkpointed the smoke test job and refreshed its lock';
  RETURN NEXT;

  SELECT *
  INTO yielded_one
  FROM public.yield_ingestion_job(created_one.ingestion_job_id)
  LIMIT 1;

  IF yielded_one.job_id IS DISTINCT FROM created_one.ingestion_job_id
     OR yielded_one.job_status IS DISTINCT FROM 'queued'::public.ingestion_job_status
     OR yielded_one.locked_at IS NOT NULL
     OR yielded_one.locked_by IS NOT NULL
     OR yielded_one.attempt IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'yield_ingestion_job did not yield the smoke test job';
  END IF;

  check_name := 'yield_ingestion_job';
  detail := 'yielded the smoke test job back to the queue';
  RETURN NEXT;

  UPDATE public.ingestion_jobs
  SET created_at = base_timestamp, updated_at = base_timestamp
  WHERE id = created_one.ingestion_job_id;

  SELECT *
  INTO reclaimed_one
  FROM public.claim_ingestion_jobs('__runtime_contract_smoke__', 1, 60, 3)
  LIMIT 1;

  IF reclaimed_one.id IS DISTINCT FROM created_one.ingestion_job_id THEN
    RAISE EXCEPTION 'claim_ingestion_jobs did not reclaim the yielded smoke test job';
  END IF;

  SELECT *
  INTO completed_one
  FROM public.complete_ingestion_job(created_one.ingestion_job_id, 'EN'::public.supported_language)
  LIMIT 1;

  IF completed_one.id IS DISTINCT FROM created_one.ingestion_job_id
     OR completed_one.job_status IS DISTINCT FROM 'completed'::public.ingestion_job_status
     OR completed_one.document_status IS DISTINCT FROM 'ready'::public.document_status THEN
    RAISE EXCEPTION 'complete_ingestion_job did not complete the smoke test job';
  END IF;

  check_name := 'complete_ingestion_job';
  detail := 'completed the smoke test job';
  RETURN NEXT;

  SELECT *
  INTO created_two
  FROM public.create_document_with_ingestion_job(
    'smoke/' || second_checksum || '.pdf',
    second_checksum,
    'Runtime Contract Smoke 2',
    NULL
  )
  LIMIT 1;

  IF created_two.document_id IS NULL OR created_two.ingestion_job_id IS NULL THEN
    RAISE EXCEPTION 'create_document_with_ingestion_job returned no row for dead-letter smoke case';
  END IF;

  UPDATE public.documents
  SET created_at = base_timestamp, updated_at = base_timestamp
  WHERE id = created_two.document_id;

  UPDATE public.ingestion_jobs
  SET created_at = base_timestamp, updated_at = base_timestamp
  WHERE id = created_two.ingestion_job_id;

  SELECT *
  INTO claimed_two
  FROM public.claim_ingestion_jobs('__runtime_contract_smoke__', 1, 60, 3)
  LIMIT 1;

  IF claimed_two.id IS DISTINCT FROM created_two.ingestion_job_id THEN
    RAISE EXCEPTION 'claim_ingestion_jobs did not claim the dead-letter smoke test job';
  END IF;

  SELECT *
  INTO failed_two
  FROM public.fail_ingestion_job(created_two.ingestion_job_id, 'runtime_contract_smoke_failure', 1)
  LIMIT 1;

  IF failed_two.id IS DISTINCT FROM created_two.ingestion_job_id
     OR failed_two.job_status IS DISTINCT FROM 'dead_letter'::public.ingestion_job_status
     OR failed_two.document_status IS DISTINCT FROM 'failed'::public.document_status
     OR failed_two.dead_letter IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fail_ingestion_job did not dead-letter the smoke test job';
  END IF;

  check_name := 'fail_ingestion_job';
  detail := 'dead-lettered the smoke test job';
  RETURN NEXT;

  SELECT *
  INTO requeued_two
  FROM public.requeue_dead_letter_document(created_two.document_id)
  LIMIT 1;

  IF requeued_two.document_id IS DISTINCT FROM created_two.document_id
     OR requeued_two.job_status IS DISTINCT FROM 'queued'::public.ingestion_job_status
     OR requeued_two.document_status IS DISTINCT FROM 'queued'::public.document_status THEN
    RAISE EXCEPTION 'requeue_dead_letter_document did not requeue the smoke test document';
  END IF;

  check_name := 'requeue_dead_letter_document';
  detail := 'requeued the smoke test document';
  RETURN NEXT;

  UPDATE public.documents
  SET status = 'failed', updated_at = now()
  WHERE id = created_one.document_id;

  SELECT *
  INTO reconciled_document
  FROM public.reconcile_document_status(created_one.document_id, 'failed', 'ready')
  LIMIT 1;

  IF reconciled_document.document_id IS DISTINCT FROM created_one.document_id
     OR reconciled_document.document_status IS DISTINCT FROM 'ready'::public.document_status THEN
    RAISE EXCEPTION 'reconcile_document_status did not repair the smoke test document';
  END IF;

  check_name := 'reconcile_document_status';
  detail := 'repaired the smoke test document status';
  RETURN NEXT;

  UPDATE public.documents
  SET status = 'processing', updated_at = now()
  WHERE id = created_two.document_id;

  UPDATE public.ingestion_jobs
  SET
    status = 'processing',
    locked_at = NULL,
    locked_by = NULL,
    updated_at = now()
  WHERE id = requeued_two.ingestion_job_id;

  SELECT *
  INTO reconciled_job
  FROM public.reconcile_ingestion_job_state(
    requeued_two.ingestion_job_id,
    'processing',
    'queued',
    true,
    'queued',
    'processing'
  )
  LIMIT 1;

  IF reconciled_job.job_id IS DISTINCT FROM requeued_two.ingestion_job_id
     OR reconciled_job.job_status IS DISTINCT FROM 'queued'::public.ingestion_job_status
     OR reconciled_job.document_status IS DISTINCT FROM 'queued'::public.document_status THEN
    RAISE EXCEPTION 'reconcile_ingestion_job_state did not repair the smoke test job';
  END IF;

  check_name := 'reconcile_ingestion_job_state';
  detail := 'repaired the smoke test job state';
  RETURN NEXT;

  DELETE FROM public.documents
  WHERE id IN (created_one.document_id, created_two.document_id);

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.smoke_test_ingestion_runtime_contract() FROM public;
GRANT EXECUTE ON FUNCTION public.smoke_test_ingestion_runtime_contract() TO service_role;
