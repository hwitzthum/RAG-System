# DATABASE_RUNBOOK.md

Version: 1.0  
Date: 2026-03-06

## Purpose

Runbook for Phase 3 database schema setup and validation.

## Scope

- apply Phase 2 and Phase 3 migrations in order
- validate schema objects, indexes, and RLS presence
- verify migration reset/push cycle in development

## Prerequisites

- Supabase CLI installed and authenticated
- project linked via `supabase link --project-ref ...`
- local Docker available if running local Supabase stack

## Migration Files

- `supabase/migrations/202603060001_phase2_bootstrap.sql`
- `supabase/migrations/202603060002_phase3_core_schema.sql`

## 1. Static Migration Validation

```bash
npm run db:validate:migrations
```

## 2. Local Apply/Reset Validation

```bash
supabase db reset --local
supabase db push --local
```

## 3. Remote Staging Apply

```bash
supabase db push
```

## 4. Post-Apply Verification Queries

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('documents', 'document_chunks', 'retrieval_cache', 'ingestion_jobs', 'query_history');

select extname from pg_extension where extname in ('vector', 'pgcrypto');

select schemaname, tablename, policyname
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;
```

## Exit Criteria

- all five public tables exist
- required indexes exist
- RLS is enabled on all public tables
- expected policies are present
- migration reset/push cycle succeeds in development
