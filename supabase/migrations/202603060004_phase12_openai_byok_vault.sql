-- Phase 12 OpenAI BYOK vault
-- Stores per-user OpenAI keys encrypted at application layer.

create table if not exists public.user_openai_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  key_version integer not null default 1 check (key_version > 0),
  key_last4 text not null check (char_length(key_last4) = 4),
  key_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_user_openai_keys_updated_at on public.user_openai_keys (updated_at desc);
create index if not exists idx_user_openai_keys_last_used_at on public.user_openai_keys (last_used_at desc);

drop trigger if exists user_openai_keys_set_updated_at on public.user_openai_keys;
create trigger user_openai_keys_set_updated_at
before update on public.user_openai_keys
for each row
execute function public.set_updated_at();

alter table public.user_openai_keys enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_openai_keys'
      and policyname = 'user_openai_keys_owner_select'
  ) then
    create policy user_openai_keys_owner_select
      on public.user_openai_keys
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_openai_keys'
      and policyname = 'user_openai_keys_owner_insert'
  ) then
    create policy user_openai_keys_owner_insert
      on public.user_openai_keys
      for insert
      to authenticated
      with check (user_id = auth.uid());
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_openai_keys'
      and policyname = 'user_openai_keys_owner_update'
  ) then
    create policy user_openai_keys_owner_update
      on public.user_openai_keys
      for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_openai_keys'
      and policyname = 'user_openai_keys_owner_delete'
  ) then
    create policy user_openai_keys_owner_delete
      on public.user_openai_keys
      for delete
      to authenticated
      using (user_id = auth.uid());
  end if;
end;
$$;
