-- Phase 12 ingestion job RPC helpers for Vercel-executed runtimes.
-- These functions provide atomic claim/finalize/fail transitions with
-- row-level locking semantics suitable for concurrent serverless invocations.

create or replace function public.claim_ingestion_jobs(
  worker_name text,
  batch_size integer default 1,
  lock_timeout_seconds integer default 900
)
returns table (
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
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_worker_name text := coalesce(nullif(worker_name, ''), 'vercel-ingestion-runner');
  normalized_batch_size integer := greatest(coalesce(batch_size, 1), 1);
  normalized_lock_timeout integer := greatest(coalesce(lock_timeout_seconds, 900), 1);
  claim_timestamp timestamptz := now();
  stale_lock_cutoff timestamptz := claim_timestamp - make_interval(secs => normalized_lock_timeout);
begin
  return query
  with candidate_jobs as (
    select ij.id
    from public.ingestion_jobs ij
    where
      (
        ij.status in ('queued', 'failed')
        and ij.locked_at is null
      )
      or (
        ij.status = 'processing'
        and ij.locked_at is not null
        and ij.locked_at <= stale_lock_cutoff
      )
    order by ij.created_at asc
    for update skip locked
    limit normalized_batch_size
  ),
  claimed_jobs as (
    update public.ingestion_jobs ij
    set
      status = 'processing',
      attempt = ij.attempt + 1,
      locked_at = claim_timestamp,
      locked_by = normalized_worker_name,
      updated_at = claim_timestamp
    from candidate_jobs cj
    where ij.id = cj.id
    returning
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
  touched_documents as (
    update public.documents d
    set
      status = 'processing',
      updated_at = claim_timestamp
    from claimed_jobs cj
    where d.id = cj.document_id
      and d.status <> 'processing'
    returning d.id
  )
  select
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
  from claimed_jobs cj
  order by cj.created_at asc;
end;
$$;

create or replace function public.complete_ingestion_job(job_id uuid)
returns table (
  id uuid,
  document_id uuid,
  job_status public.ingestion_job_status,
  document_status public.document_status,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  completion_timestamp timestamptz := now();
begin
  return query
  with completed_job as (
    update public.ingestion_jobs ij
    set
      status = 'completed',
      last_error = null,
      locked_at = null,
      locked_by = null,
      updated_at = completion_timestamp
    where ij.id = job_id
      and ij.status = 'processing'
    returning ij.id, ij.document_id, ij.status, ij.updated_at
  ),
  updated_document as (
    update public.documents d
    set
      status = 'ready',
      updated_at = completion_timestamp
    from completed_job cj
    where d.id = cj.document_id
    returning d.id, d.status
  )
  select
    cj.id,
    cj.document_id,
    cj.status as job_status,
    ud.status as document_status,
    cj.updated_at
  from completed_job cj
  join updated_document ud on ud.id = cj.document_id;
end;
$$;

create or replace function public.fail_ingestion_job(
  job_id uuid,
  error_text text,
  max_retries integer default 3
)
returns table (
  id uuid,
  document_id uuid,
  job_status public.ingestion_job_status,
  attempt integer,
  dead_letter boolean,
  document_status public.document_status,
  last_error text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  failure_timestamp timestamptz := now();
  normalized_max_retries integer := greatest(coalesce(max_retries, 1), 1);
begin
  return query
  with failed_job as (
    update public.ingestion_jobs ij
    set
      status = case
        when ij.attempt >= normalized_max_retries then 'dead_letter'::public.ingestion_job_status
        else 'failed'::public.ingestion_job_status
      end,
      last_error = left(coalesce(error_text, 'unknown_error'), 4000),
      locked_at = null,
      locked_by = null,
      updated_at = failure_timestamp
    where ij.id = job_id
      and ij.status = 'processing'
    returning ij.id, ij.document_id, ij.status, ij.attempt, ij.last_error, ij.updated_at
  ),
  updated_document as (
    update public.documents d
    set
      status = case
        when fj.status = 'dead_letter' then 'failed'::public.document_status
        else 'queued'::public.document_status
      end,
      updated_at = failure_timestamp
    from failed_job fj
    where d.id = fj.document_id
    returning d.id, d.status
  )
  select
    fj.id,
    fj.document_id,
    fj.status as job_status,
    fj.attempt,
    (fj.status = 'dead_letter') as dead_letter,
    ud.status as document_status,
    fj.last_error,
    fj.updated_at
  from failed_job fj
  join updated_document ud on ud.id = fj.document_id;
end;
$$;

revoke all on function public.claim_ingestion_jobs(text, integer, integer) from public;
revoke all on function public.complete_ingestion_job(uuid) from public;
revoke all on function public.fail_ingestion_job(uuid, text, integer) from public;

grant execute on function public.claim_ingestion_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_ingestion_job(uuid) to service_role;
grant execute on function public.fail_ingestion_job(uuid, text, integer) to service_role;
