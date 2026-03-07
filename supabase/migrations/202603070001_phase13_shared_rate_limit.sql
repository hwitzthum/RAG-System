-- Phase 13 shared rate limiting
-- Adds a Supabase-backed limiter for multi-instance deployments.

create table if not exists public.rate_limit_buckets (
  bucket_key text primary key,
  request_count integer not null default 0 check (request_count >= 0),
  window_started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_rate_limit_buckets_updated_at on public.rate_limit_buckets (updated_at);

alter table public.rate_limit_buckets enable row level security;

revoke all on table public.rate_limit_buckets from public;
revoke all on table public.rate_limit_buckets from anon;
revoke all on table public.rate_limit_buckets from authenticated;
grant all on table public.rate_limit_buckets to service_role;

DROP TRIGGER IF EXISTS rate_limit_buckets_set_updated_at ON public.rate_limit_buckets;
CREATE TRIGGER rate_limit_buckets_set_updated_at
BEFORE UPDATE ON public.rate_limit_buckets
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

create or replace function public.consume_rate_limit(
  bucket_key_input text,
  max_requests_input integer,
  window_seconds_input integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer,
  request_count integer,
  window_started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_timestamp timestamptz := clock_timestamp();
  current_window interval := make_interval(secs => greatest(window_seconds_input, 1));
begin
  if bucket_key_input is null or length(trim(bucket_key_input)) = 0 then
    raise exception 'bucket_key_input must not be empty';
  end if;

  if coalesce(max_requests_input, 0) <= 0 then
    raise exception 'max_requests_input must be positive';
  end if;

  if coalesce(window_seconds_input, 0) <= 0 then
    raise exception 'window_seconds_input must be positive';
  end if;

  insert into public.rate_limit_buckets as buckets (
    bucket_key,
    request_count,
    window_started_at,
    created_at,
    updated_at
  )
  values (
    bucket_key_input,
    1,
    current_timestamp,
    current_timestamp,
    current_timestamp
  )
  on conflict (bucket_key) do update
    set request_count = case
      when buckets.window_started_at + current_window <= excluded.window_started_at then 1
      else buckets.request_count + 1
    end,
    window_started_at = case
      when buckets.window_started_at + current_window <= excluded.window_started_at then excluded.window_started_at
      else buckets.window_started_at
    end,
    updated_at = excluded.updated_at
  returning
    buckets.request_count,
    buckets.window_started_at
  into request_count, window_started_at;

  allowed := request_count <= max_requests_input;
  remaining := greatest(max_requests_input - request_count, 0);
  retry_after_seconds := greatest(
    ceil(extract(epoch from ((window_started_at + current_window) - current_timestamp)))::integer,
    1
  );

  return next;
end;
$$;

revoke execute on function public.consume_rate_limit(text, integer, integer) from public;
revoke execute on function public.consume_rate_limit(text, integer, integer) from anon;
revoke execute on function public.consume_rate_limit(text, integer, integer) from authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
