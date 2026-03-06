-- Phase 2 infrastructure bootstrap
-- Enables pgvector and configures the private PDF storage bucket.

create extension if not exists vector;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Admins can upload/read/delete files in documents bucket.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'documents_admin_full_access'
  ) then
    create policy documents_admin_full_access
      on storage.objects
      for all
      to authenticated
      using (
        bucket_id = 'documents'
        and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
      )
      with check (
        bucket_id = 'documents'
        and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
      );
  end if;
end;
$$;

-- Readers and admins can read files in documents bucket.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'documents_reader_select'
  ) then
    create policy documents_reader_select
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'documents'
        and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('reader', 'admin')
      );
  end if;
end;
$$;
