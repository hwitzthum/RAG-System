-- Move the RLS and trigger helpers out of the shared `public` schema.
--
-- Follows 20260804085000, which moved this app's internal text-search helpers
-- for the same reason: `public` is shared with Rezeptmeister, whose schema is
-- managed independently by Alembic, and `create or replace function` overwrites
-- silently rather than warning.
--
-- These four are the higher-stakes case. `is_admin()`, `is_reader_or_admin()`
-- and `app_role()` are named about as generically as a function can be, and 11
-- RLS policies evaluate them — including one on `storage.objects`. If the other
-- application ever defined `public.is_admin()`, `create or replace` would
-- replace the body *in place*, keeping the same OID, and every policy here
-- would silently start evaluating a different application's notion of "admin".
-- That is an authorisation bypass, not a naming annoyance.
--
-- `set_updated_at()` is included because it is equally generic and drives six
-- triggers. Rezeptmeister's equivalent is named `update_updated_at`, so the two
-- coexist today by naming luck rather than by design.
--
-- Why this is safe:
--   - Policies and triggers reference functions by OID, not by name. Both
--     ALTER ... SET SCHEMA and CREATE OR REPLACE preserve the OID, so all 11
--     policies and 6 triggers follow the functions automatically; there is no
--     policy to drop and recreate, and therefore no window in which a table is
--     left unprotected.
--   - The failure mode if a grant were wrong is fail-closed: the policy
--     expression raises "permission denied for schema rag" and the query fails.
--     It cannot silently widen access.
--
-- Nothing outside the database calls these — verified against the TypeScript,
-- scripts, views and other function bodies before writing this.

-- ---------------------------------------------------------------------------
-- 1. Relocate. OIDs are preserved, so dependent policies and triggers follow.
-- ---------------------------------------------------------------------------

alter function public.app_role() set schema rag;
alter function public.is_admin() set schema rag;
alter function public.is_reader_or_admin() set schema rag;
alter function public.set_updated_at() set schema rag;

-- ---------------------------------------------------------------------------
-- 2. Re-point the internal references.
-- ---------------------------------------------------------------------------

-- is_admin() and is_reader_or_admin() call app_role() by its old qualified
-- name; moving app_role() would leave them calling a function that no longer
-- exists at `public.app_role`. CREATE OR REPLACE keeps each OID, so the
-- policies built on them are unaffected.
create or replace function rag.is_admin()
returns boolean
language sql
stable
as $$
  select rag.app_role() = 'admin';
$$;

create or replace function rag.is_reader_or_admin()
returns boolean
language sql
stable
as $$
  select rag.app_role() in ('reader', 'admin');
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------

-- Policy expressions are evaluated as the querying role, so `authenticated`
-- must be able to reach these. Every policy involved is TO authenticated, so
-- `anon` deliberately gets nothing. Schema usage was granted in 20260804085000.
grant execute on function rag.app_role() to authenticated, service_role;
grant execute on function rag.is_admin() to authenticated, service_role;
grant execute on function rag.is_reader_or_admin() to authenticated, service_role;
grant execute on function rag.set_updated_at() to authenticated, service_role;
