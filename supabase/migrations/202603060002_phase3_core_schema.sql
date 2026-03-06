-- Phase 3 core schema
-- Creates production tables, indexes, and RLS for the RAG system.

create extension if not exists pgcrypto;

-- Optional helper functions for policy readability.
create or replace function public.app_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select public.app_role() = 'admin';
$$;

create or replace function public.is_reader_or_admin()
returns boolean
language sql
stable
as $$
  select public.app_role() in ('reader', 'admin');
$$;

-- Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'supported_language') THEN
    CREATE TYPE supported_language AS ENUM ('EN', 'DE', 'FR', 'IT', 'ES');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_status') THEN
    CREATE TYPE document_status AS ENUM ('queued', 'processing', 'ready', 'failed');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ingestion_job_status') THEN
    CREATE TYPE ingestion_job_status AS ENUM ('queued', 'processing', 'completed', 'failed', 'dead_letter');
  END IF;
END;
$$;

-- Common timestamp trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- documents
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  sha256 text not null unique,
  title text,
  language supported_language,
  status document_status not null default 'queued',
  ingestion_version integer not null default 1 check (ingestion_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- document_chunks
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  page_number integer not null check (page_number > 0),
  section_title text,
  content text not null,
  context text not null,
  language supported_language not null,
  -- Default embedding dimension. If model changes, run an explicit migration.
  embedding vector(1536) not null,
  tsv tsvector not null default ''::tsvector,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- retrieval_cache
create table if not exists public.retrieval_cache (
  cache_key text primary key,
  normalized_query text not null,
  language supported_language not null,
  retrieval_version integer not null check (retrieval_version > 0),
  chunk_ids uuid[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  hit_count integer not null default 0 check (hit_count >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_accessed_at timestamptz not null default now()
);

-- ingestion_jobs
create table if not exists public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  status ingestion_job_status not null default 'queued',
  attempt integer not null default 0 check (attempt >= 0),
  last_error text,
  idempotency_key text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idempotency_key)
);

-- query_history
create table if not exists public.query_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid,
  query text not null,
  answer text not null,
  citations jsonb not null default '[]'::jsonb,
  latency_ms integer not null check (latency_ms >= 0),
  cache_hit boolean not null default false,
  created_at timestamptz not null default now()
);

-- Trigger wiring
DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS ingestion_jobs_set_updated_at ON public.ingestion_jobs;
CREATE TRIGGER ingestion_jobs_set_updated_at
BEFORE UPDATE ON public.ingestion_jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

create or replace function public.document_chunks_set_tsv()
returns trigger
language plpgsql
as $$
begin
  new.tsv := to_tsvector(
    'simple'::regconfig,
    coalesce(new.section_title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(new.context, '')
  );
  return new;
end;
$$;

DROP TRIGGER IF EXISTS document_chunks_set_tsv_trigger ON public.document_chunks;
CREATE TRIGGER document_chunks_set_tsv_trigger
BEFORE INSERT OR UPDATE ON public.document_chunks
FOR EACH ROW
EXECUTE FUNCTION public.document_chunks_set_tsv();

-- Indexes (vector, text search, lifecycle)
create index if not exists idx_documents_status on public.documents (status);
create index if not exists idx_documents_language on public.documents (language);
create index if not exists idx_documents_ingestion_version on public.documents (ingestion_version);

create index if not exists idx_document_chunks_document_id on public.document_chunks (document_id);
create index if not exists idx_document_chunks_language on public.document_chunks (language);
create index if not exists idx_document_chunks_page_number on public.document_chunks (page_number);
create index if not exists idx_document_chunks_tsv on public.document_chunks using gin (tsv);
create index if not exists idx_document_chunks_embedding_ivfflat
  on public.document_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists idx_retrieval_cache_expires_at on public.retrieval_cache (expires_at);
create index if not exists idx_retrieval_cache_version_language on public.retrieval_cache (retrieval_version, language);
create index if not exists idx_retrieval_cache_normalized_query on public.retrieval_cache (normalized_query);

create index if not exists idx_ingestion_jobs_status on public.ingestion_jobs (status);
create index if not exists idx_ingestion_jobs_document_id on public.ingestion_jobs (document_id);
create index if not exists idx_ingestion_jobs_locked_at on public.ingestion_jobs (locked_at);
create index if not exists idx_ingestion_jobs_created_at on public.ingestion_jobs (created_at);

create index if not exists idx_query_history_user_created on public.query_history (user_id, created_at desc);
create index if not exists idx_query_history_conversation_created on public.query_history (conversation_id, created_at desc);
create index if not exists idx_query_history_created_at on public.query_history (created_at desc);

-- RLS
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.retrieval_cache enable row level security;
alter table public.ingestion_jobs enable row level security;
alter table public.query_history enable row level security;

-- documents policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents' AND policyname = 'documents_select_reader_admin'
  ) THEN
    CREATE POLICY documents_select_reader_admin
      ON public.documents
      FOR SELECT
      TO authenticated
      USING (
        public.is_reader_or_admin()
        AND (status = 'ready' OR public.is_admin())
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents' AND policyname = 'documents_admin_write'
  ) THEN
    CREATE POLICY documents_admin_write
      ON public.documents
      FOR ALL
      TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;
END;
$$;

-- document_chunks policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'document_chunks' AND policyname = 'document_chunks_select_reader_admin'
  ) THEN
    CREATE POLICY document_chunks_select_reader_admin
      ON public.document_chunks
      FOR SELECT
      TO authenticated
      USING (
        public.is_reader_or_admin()
        AND EXISTS (
          SELECT 1
          FROM public.documents d
          WHERE d.id = document_id
            AND (d.status = 'ready' OR public.is_admin())
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'document_chunks' AND policyname = 'document_chunks_admin_write'
  ) THEN
    CREATE POLICY document_chunks_admin_write
      ON public.document_chunks
      FOR ALL
      TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;
END;
$$;

-- retrieval_cache policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'retrieval_cache' AND policyname = 'retrieval_cache_admin_full_access'
  ) THEN
    CREATE POLICY retrieval_cache_admin_full_access
      ON public.retrieval_cache
      FOR ALL
      TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;
END;
$$;

-- ingestion_jobs policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ingestion_jobs' AND policyname = 'ingestion_jobs_admin_full_access'
  ) THEN
    CREATE POLICY ingestion_jobs_admin_full_access
      ON public.ingestion_jobs
      FOR ALL
      TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;
END;
$$;

-- query_history policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'query_history' AND policyname = 'query_history_user_select'
  ) THEN
    CREATE POLICY query_history_user_select
      ON public.query_history
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid() OR public.is_admin());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'query_history' AND policyname = 'query_history_user_insert'
  ) THEN
    CREATE POLICY query_history_user_insert
      ON public.query_history
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid() OR public.is_admin());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'query_history' AND policyname = 'query_history_user_update'
  ) THEN
    CREATE POLICY query_history_user_update
      ON public.query_history
      FOR UPDATE
      TO authenticated
      USING (user_id = auth.uid() OR public.is_admin())
      WITH CHECK (user_id = auth.uid() OR public.is_admin());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'query_history' AND policyname = 'query_history_user_delete'
  ) THEN
    CREATE POLICY query_history_user_delete
      ON public.query_history
      FOR DELETE
      TO authenticated
      USING (user_id = auth.uid() OR public.is_admin());
  END IF;
END;
$$;
