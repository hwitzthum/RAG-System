CREATE OR REPLACE VIEW public.document_effective_statuses AS
SELECT
  d.id AS document_id,
  d.title,
  d.storage_path,
  d.sha256,
  d.language,
  d.status AS raw_document_status,
  d.ingestion_version,
  d.created_at,
  d.updated_at,
  lj.id AS latest_job_id,
  lj.status AS latest_job_status,
  lj.attempt AS latest_job_attempt,
  lj.last_error AS latest_job_last_error,
  lj.locked_at AS latest_job_locked_at,
  lj.locked_by AS latest_job_locked_by,
  lj.created_at AS latest_job_created_at,
  lj.updated_at AS latest_job_updated_at,
  COALESCE(dc.chunk_count, 0)::integer AS chunk_count,
  CASE
    WHEN lj.status = 'processing'::public.ingestion_job_status THEN 'processing'::public.document_status
    WHEN lj.status IN ('queued'::public.ingestion_job_status, 'failed'::public.ingestion_job_status) THEN 'queued'::public.document_status
    WHEN lj.status = 'dead_letter'::public.ingestion_job_status THEN 'failed'::public.document_status
    WHEN lj.status = 'completed'::public.ingestion_job_status AND COALESCE(dc.chunk_count, 0) > 0 THEN 'ready'::public.document_status
    WHEN lj.status = 'completed'::public.ingestion_job_status AND COALESCE(dc.chunk_count, 0) = 0 THEN 'failed'::public.document_status
    ELSE d.status
  END AS effective_status
FROM public.documents d
LEFT JOIN LATERAL (
  SELECT
    ij.id,
    ij.status,
    ij.attempt,
    ij.last_error,
    ij.locked_at,
    ij.locked_by,
    ij.created_at,
    ij.updated_at
  FROM public.ingestion_jobs ij
  WHERE ij.document_id = d.id
  ORDER BY ij.created_at DESC
  LIMIT 1
) lj ON TRUE
LEFT JOIN (
  SELECT document_id, COUNT(*)::integer AS chunk_count
  FROM public.document_chunks
  GROUP BY document_id
) dc ON dc.document_id = d.id;
