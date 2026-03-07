-- Phase 14: Automatically assign 'reader' role to new sign-ups via app_metadata.
-- Existing RLS functions (app_role, is_admin, is_reader_or_admin) already read from
-- auth.jwt() -> 'app_metadata' ->> 'role' and work unchanged.

CREATE OR REPLACE FUNCTION public.handle_new_user_default_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "reader"}'::jsonb
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_set_default_role ON auth.users;

CREATE TRIGGER on_auth_user_created_set_default_role
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_default_role();
