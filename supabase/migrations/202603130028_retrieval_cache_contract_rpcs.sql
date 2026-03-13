CREATE OR REPLACE FUNCTION public.upsert_retrieval_cache_entry(
  target_cache_key text,
  target_normalized_query text,
  target_language public.supported_language,
  target_retrieval_version integer,
  target_chunk_ids uuid[] DEFAULT '{}'::uuid[],
  target_payload jsonb DEFAULT '{}'::jsonb,
  target_expires_at timestamptz DEFAULT now() + interval '1 hour',
  target_created_at timestamptz DEFAULT now(),
  target_last_accessed_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  cache_key text,
  retrieval_version integer,
  expires_at timestamptz,
  last_accessed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.retrieval_cache (
    cache_key,
    normalized_query,
    language,
    retrieval_version,
    chunk_ids,
    payload,
    hit_count,
    created_at,
    expires_at,
    last_accessed_at
  )
  VALUES (
    target_cache_key,
    target_normalized_query,
    target_language,
    target_retrieval_version,
    COALESCE(target_chunk_ids, '{}'::uuid[]),
    COALESCE(target_payload, '{}'::jsonb),
    0,
    target_created_at,
    target_expires_at,
    target_last_accessed_at
  )
  ON CONFLICT (cache_key)
  DO UPDATE SET
    normalized_query = EXCLUDED.normalized_query,
    language = EXCLUDED.language,
    retrieval_version = EXCLUDED.retrieval_version,
    chunk_ids = EXCLUDED.chunk_ids,
    payload = EXCLUDED.payload,
    hit_count = 0,
    created_at = EXCLUDED.created_at,
    expires_at = EXCLUDED.expires_at,
    last_accessed_at = EXCLUDED.last_accessed_at
  RETURNING retrieval_cache.cache_key, retrieval_cache.retrieval_version, retrieval_cache.expires_at, retrieval_cache.last_accessed_at;
$$;

REVOKE ALL ON FUNCTION public.upsert_retrieval_cache_entry(text, text, public.supported_language, integer, uuid[], jsonb, timestamptz, timestamptz, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_retrieval_cache_entry(text, text, public.supported_language, integer, uuid[], jsonb, timestamptz, timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.touch_retrieval_cache_entry(
  target_cache_key text,
  target_retrieval_version integer,
  target_last_accessed_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  cache_key text,
  hit_count integer,
  last_accessed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.retrieval_cache rc
  SET
    hit_count = rc.hit_count + 1,
    last_accessed_at = target_last_accessed_at
  WHERE rc.cache_key = target_cache_key
    AND rc.retrieval_version = target_retrieval_version
  RETURNING rc.cache_key, rc.hit_count, rc.last_accessed_at;
$$;

REVOKE ALL ON FUNCTION public.touch_retrieval_cache_entry(text, integer, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.touch_retrieval_cache_entry(text, integer, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.prune_retrieval_cache_entries(
  target_current_retrieval_version integer,
  target_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  expired_deleted_count bigint,
  stale_version_deleted_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH expired_entries AS (
    DELETE FROM public.retrieval_cache
    WHERE expires_at <= target_now
    RETURNING cache_key
  ),
  stale_version_entries AS (
    DELETE FROM public.retrieval_cache
    WHERE retrieval_version < target_current_retrieval_version
    RETURNING cache_key
  )
  SELECT
    (SELECT count(*) FROM expired_entries) AS expired_deleted_count,
    (SELECT count(*) FROM stale_version_entries) AS stale_version_deleted_count;
$$;

REVOKE ALL ON FUNCTION public.prune_retrieval_cache_entries(integer, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.prune_retrieval_cache_entries(integer, timestamptz) TO service_role;
