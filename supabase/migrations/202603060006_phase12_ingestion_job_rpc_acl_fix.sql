-- Phase 12 ACL hardening for ingestion RPC functions.
-- Supabase default grants can expose new functions to anon/authenticated.
-- Explicitly restrict execution to service_role.

revoke execute on function public.claim_ingestion_jobs(text, integer, integer) from public;
revoke execute on function public.claim_ingestion_jobs(text, integer, integer) from anon;
revoke execute on function public.claim_ingestion_jobs(text, integer, integer) from authenticated;
grant execute on function public.claim_ingestion_jobs(text, integer, integer) to service_role;

revoke execute on function public.complete_ingestion_job(uuid) from public;
revoke execute on function public.complete_ingestion_job(uuid) from anon;
revoke execute on function public.complete_ingestion_job(uuid) from authenticated;
grant execute on function public.complete_ingestion_job(uuid) to service_role;

revoke execute on function public.fail_ingestion_job(uuid, text, integer) from public;
revoke execute on function public.fail_ingestion_job(uuid, text, integer) from anon;
revoke execute on function public.fail_ingestion_job(uuid, text, integer) from authenticated;
grant execute on function public.fail_ingestion_job(uuid, text, integer) to service_role;
