CREATE OR REPLACE FUNCTION public.get_admin_runtime_snapshot(
  target_now timestamptz DEFAULT now(),
  target_no_progress_minutes integer DEFAULT 15,
  target_stale_processing_minutes integer DEFAULT 20,
  target_heartbeat_lag_minutes integer DEFAULT 5,
  target_current_retrieval_version integer DEFAULT 1
)
RETURNS TABLE (
  queued_count bigint,
  processing_count bigint,
  recent_progress_count bigint,
  stale_processing_count bigint,
  lagging_processing_count bigint,
  max_heartbeat_lag_seconds integer,
  processing_without_lock_count bigint,
  non_processing_with_lock_count bigint,
  inconsistent_document_count bigint,
  ready_without_chunks_count bigint,
  stage_counts jsonb,
  effective_document_counts jsonb,
  total_cache_entries bigint,
  current_version_cache_entries bigint,
  stale_version_cache_entries bigint,
  expired_cache_entries bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH all_job_rows AS (
    SELECT
      status,
      locked_at,
      locked_by,
      updated_at,
      COALESCE(NULLIF(btrim(current_stage), ''), 'unknown') AS stage
    FROM public.ingestion_jobs
  ),
  processing_rows AS (
    SELECT *
    FROM all_job_rows
    WHERE status = 'processing'
  ),
  queue_metrics AS (
    SELECT
      count(*) FILTER (WHERE status = 'queued')::bigint AS queued_count,
      count(*) FILTER (
        WHERE status IN ('processing', 'completed', 'failed', 'dead_letter')
          AND updated_at >= target_now - make_interval(mins => GREATEST(target_no_progress_minutes, 0))
      )::bigint AS recent_progress_count,
      count(*) FILTER (
        WHERE status IN ('queued', 'failed', 'dead_letter', 'completed')
          AND locked_at IS NOT NULL
      )::bigint AS non_processing_with_lock_count
    FROM all_job_rows
  ),
  processing_metrics AS (
    SELECT
      count(*)::bigint AS processing_count,
      count(*) FILTER (WHERE locked_at IS NULL OR locked_by IS NULL)::bigint AS processing_without_lock_count,
      count(*) FILTER (
        WHERE locked_at IS NOT NULL
          AND locked_by IS NOT NULL
          AND locked_at <= target_now - make_interval(mins => GREATEST(target_stale_processing_minutes, 0))
      )::bigint AS stale_processing_count,
      count(*) FILTER (
        WHERE locked_at IS NOT NULL
          AND locked_by IS NOT NULL
          AND locked_at > target_now - make_interval(mins => GREATEST(target_stale_processing_minutes, 0))
          AND updated_at <= target_now - make_interval(mins => GREATEST(target_heartbeat_lag_minutes, 0))
      )::bigint AS lagging_processing_count,
      max(
        GREATEST(
          0,
          floor(extract(epoch FROM (target_now - updated_at)))::integer
        )
      ) FILTER (
        WHERE locked_at IS NOT NULL
          AND locked_by IS NOT NULL
          AND locked_at > target_now - make_interval(mins => GREATEST(target_stale_processing_minutes, 0))
      ) AS max_heartbeat_lag_seconds
    FROM processing_rows
  ),
  processing_stage_counts AS (
    SELECT COALESCE(jsonb_object_agg(stage, stage_count ORDER BY stage), '{}'::jsonb) AS stage_counts
    FROM (
      SELECT stage, count(*)::bigint AS stage_count
      FROM processing_rows
      GROUP BY stage
    ) counted_stages
  ),
  effective_document_metrics AS (
    SELECT
      count(*) FILTER (
        WHERE raw_document_status = 'processing'
          AND latest_job_status IS DISTINCT FROM 'processing'
      )::bigint AS inconsistent_document_count,
      count(*) FILTER (
        WHERE raw_document_status = 'ready'
          AND chunk_count = 0
      )::bigint AS ready_without_chunks_count,
      jsonb_build_object(
        'queued', count(*) FILTER (WHERE effective_status = 'queued'),
        'processing', count(*) FILTER (WHERE effective_status = 'processing'),
        'ready', count(*) FILTER (WHERE effective_status = 'ready'),
        'failed', count(*) FILTER (WHERE effective_status = 'failed')
      ) AS effective_document_counts
    FROM public.document_effective_statuses
  ),
  retrieval_cache_metrics AS (
    SELECT
      count(*)::bigint AS total_cache_entries,
      count(*) FILTER (WHERE retrieval_version = target_current_retrieval_version)::bigint AS current_version_cache_entries,
      count(*) FILTER (WHERE retrieval_version < target_current_retrieval_version)::bigint AS stale_version_cache_entries,
      count(*) FILTER (WHERE expires_at <= target_now)::bigint AS expired_cache_entries
    FROM public.retrieval_cache
  )
  SELECT
    queue_metrics.queued_count,
    processing_metrics.processing_count,
    queue_metrics.recent_progress_count,
    processing_metrics.stale_processing_count,
    processing_metrics.lagging_processing_count,
    processing_metrics.max_heartbeat_lag_seconds,
    processing_metrics.processing_without_lock_count,
    queue_metrics.non_processing_with_lock_count,
    effective_document_metrics.inconsistent_document_count,
    effective_document_metrics.ready_without_chunks_count,
    processing_stage_counts.stage_counts,
    effective_document_metrics.effective_document_counts,
    retrieval_cache_metrics.total_cache_entries,
    retrieval_cache_metrics.current_version_cache_entries,
    retrieval_cache_metrics.stale_version_cache_entries,
    retrieval_cache_metrics.expired_cache_entries
  FROM queue_metrics
  CROSS JOIN processing_metrics
  CROSS JOIN processing_stage_counts
  CROSS JOIN effective_document_metrics
  CROSS JOIN retrieval_cache_metrics;
$$;

REVOKE ALL ON FUNCTION public.get_admin_runtime_snapshot(timestamptz, integer, integer, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_admin_runtime_snapshot(timestamptz, integer, integer, integer, integer) TO service_role;
