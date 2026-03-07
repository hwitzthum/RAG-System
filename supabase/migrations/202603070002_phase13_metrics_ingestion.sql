-- Phase 13 metrics ingestion sink
-- Stores structured metric events received by the internal observability endpoint.

create table if not exists public.metric_events (
  id uuid primary key default gen_random_uuid(),
  metric_name text not null,
  value double precision not null,
  unit text,
  tags jsonb not null default '{}'::jsonb,
  source text not null default 'web',
  created_at timestamptz not null default now()
);

create index if not exists idx_metric_events_metric_name_created_at
  on public.metric_events (metric_name, created_at desc);
create index if not exists idx_metric_events_created_at on public.metric_events (created_at desc);
create index if not exists idx_metric_events_tags_gin on public.metric_events using gin (tags);

alter table public.metric_events enable row level security;

revoke all on table public.metric_events from public;
revoke all on table public.metric_events from anon;
revoke all on table public.metric_events from authenticated;
grant all on table public.metric_events to service_role;
