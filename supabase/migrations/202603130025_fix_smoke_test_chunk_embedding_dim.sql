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
  third_checksum text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  base_timestamp timestamptz := timestamptz '2000-01-01T00:00:00Z';
  smoke_embedding jsonb := to_jsonb(ARRAY(SELECT 0.0::double precision FROM generate_series(1, 1024)));
  created_one record;
  created_two record;
  created_three record;
  claimed_one record;
  reclaimed_one record;
  claimed_two record;
  checkpointed_one record;
  yielded_one record;
  completed_one record;
  failed_two record;
  requeued_two record;
  ensured_three record;
  replaced_chunks record;
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
    1,
    'chunking'
  )
  LIMIT 1;

  IF checkpointed_one.job_id IS DISTINCT FROM created_one.ingestion_job_id
     OR checkpointed_one.chunks_total IS DISTINCT FROM 2
     OR checkpointed_one.chunks_processed IS DISTINCT FROM 1
     OR checkpointed_one.current_stage IS DISTINCT FROM 'chunking'
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
     OR yielded_one.attempt IS DISTINCT FROM 0
     OR yielded_one.current_stage IS DISTINCT FROM 'yielded' THEN
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
  INTO replaced_chunks
  FROM public.replace_document_chunks(
    created_one.document_id,
    jsonb_build_array(
      jsonb_build_object(
        'chunk_index', 0,
        'page_number', 1,
        'section_title', 'Smoke',
        'content', 'Chunk content',
        'context', 'Chunk context',
        'language', 'EN',
        'embedding', smoke_embedding
      )
    )
  )
  LIMIT 1;

  IF replaced_chunks.document_id IS DISTINCT FROM created_one.document_id
     OR replaced_chunks.inserted_chunk_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'replace_document_chunks did not replace chunks for the smoke test document';
  END IF;

  check_name := 'replace_document_chunks';
  detail := 'replaced chunks for the smoke test document';
  RETURN NEXT;

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

  SELECT *
  INTO created_three
  FROM public.create_document_with_ingestion_job(
    'smoke/' || third_checksum || '.pdf',
    third_checksum,
    'Runtime Contract Smoke 3',
    NULL
  )
  LIMIT 1;

  IF created_three.document_id IS NULL OR created_three.ingestion_job_id IS NULL THEN
    RAISE EXCEPTION 'create_document_with_ingestion_job returned no row for ensure-document smoke case';
  END IF;

  DELETE FROM public.ingestion_jobs
  WHERE id = created_three.ingestion_job_id;

  UPDATE public.documents
  SET status = 'ready', updated_at = base_timestamp
  WHERE id = created_three.document_id;

  SELECT *
  INTO ensured_three
  FROM public.ensure_document_queued_ingestion_job(created_three.document_id)
  LIMIT 1;

  IF ensured_three.document_id IS DISTINCT FROM created_three.document_id
     OR ensured_three.job_status IS DISTINCT FROM 'queued'::public.ingestion_job_status
     OR ensured_three.document_status IS DISTINCT FROM 'queued'::public.document_status
     OR ensured_three.job_created IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ensure_document_queued_ingestion_job did not recreate a queued job for the smoke test document';
  END IF;

  check_name := 'ensure_document_queued_ingestion_job';
  detail := 'recreated a queued job for a document with no jobs';
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

  DELETE FROM public.document_chunks
  WHERE document_id IN (created_one.document_id, created_two.document_id, created_three.document_id);

  DELETE FROM public.documents
  WHERE id IN (created_one.document_id, created_two.document_id, created_three.document_id);

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.smoke_test_ingestion_runtime_contract() FROM public;
GRANT EXECUTE ON FUNCTION public.smoke_test_ingestion_runtime_contract() TO service_role;
