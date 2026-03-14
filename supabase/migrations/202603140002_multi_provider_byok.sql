ALTER TABLE public.documents
ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_user_id ON public.documents (user_id);

CREATE TABLE IF NOT EXISTS public.user_cohere_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  key_last4 text NOT NULL CHECK (char_length(key_last4) = 4),
  key_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_user_cohere_keys_updated_at ON public.user_cohere_keys (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_cohere_keys_last_used_at ON public.user_cohere_keys (last_used_at DESC);

DROP TRIGGER IF EXISTS user_cohere_keys_set_updated_at ON public.user_cohere_keys;
CREATE TRIGGER user_cohere_keys_set_updated_at
BEFORE UPDATE ON public.user_cohere_keys
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_cohere_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_cohere_keys'
      AND policyname = 'user_cohere_keys_owner_select'
  ) THEN
    CREATE POLICY user_cohere_keys_owner_select
      ON public.user_cohere_keys
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_cohere_keys'
      AND policyname = 'user_cohere_keys_owner_insert'
  ) THEN
    CREATE POLICY user_cohere_keys_owner_insert
      ON public.user_cohere_keys
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_cohere_keys'
      AND policyname = 'user_cohere_keys_owner_update'
  ) THEN
    CREATE POLICY user_cohere_keys_owner_update
      ON public.user_cohere_keys
      FOR UPDATE
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_cohere_keys'
      AND policyname = 'user_cohere_keys_owner_delete'
  ) THEN
    CREATE POLICY user_cohere_keys_owner_delete
      ON public.user_cohere_keys
      FOR DELETE
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.user_anthropic_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  key_last4 text NOT NULL CHECK (char_length(key_last4) = 4),
  key_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_user_anthropic_keys_updated_at ON public.user_anthropic_keys (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_anthropic_keys_last_used_at ON public.user_anthropic_keys (last_used_at DESC);

DROP TRIGGER IF EXISTS user_anthropic_keys_set_updated_at ON public.user_anthropic_keys;
CREATE TRIGGER user_anthropic_keys_set_updated_at
BEFORE UPDATE ON public.user_anthropic_keys
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_anthropic_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_anthropic_keys'
      AND policyname = 'user_anthropic_keys_owner_select'
  ) THEN
    CREATE POLICY user_anthropic_keys_owner_select
      ON public.user_anthropic_keys
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_anthropic_keys'
      AND policyname = 'user_anthropic_keys_owner_insert'
  ) THEN
    CREATE POLICY user_anthropic_keys_owner_insert
      ON public.user_anthropic_keys
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_anthropic_keys'
      AND policyname = 'user_anthropic_keys_owner_update'
  ) THEN
    CREATE POLICY user_anthropic_keys_owner_update
      ON public.user_anthropic_keys
      FOR UPDATE
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_anthropic_keys'
      AND policyname = 'user_anthropic_keys_owner_delete'
  ) THEN
    CREATE POLICY user_anthropic_keys_owner_delete
      ON public.user_anthropic_keys
      FOR DELETE
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_document_with_ingestion_job_for_user(
  target_storage_path text,
  target_sha256 text,
  target_title text DEFAULT NULL,
  target_language public.supported_language DEFAULT NULL,
  target_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  document_id uuid,
  ingestion_job_id uuid,
  document_status public.document_status,
  job_status public.ingestion_job_status,
  ingestion_version integer,
  storage_path text,
  sha256 text,
  idempotency_key text,
  created_at timestamptz,
  user_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inserted_document AS (
    INSERT INTO public.documents (
      storage_path,
      sha256,
      title,
      language,
      status,
      ingestion_version,
      user_id
    )
    VALUES (
      target_storage_path,
      target_sha256,
      target_title,
      target_language,
      'queued'::public.document_status,
      1,
      target_user_id
    )
    ON CONFLICT ON CONSTRAINT documents_sha256_key DO NOTHING
    RETURNING id, status, ingestion_version, storage_path, sha256, created_at, user_id
  ),
  inserted_job AS (
    INSERT INTO public.ingestion_jobs (
      document_id,
      status,
      attempt,
      idempotency_key,
      created_at,
      updated_at
    )
    SELECT
      d.id,
      'queued'::public.ingestion_job_status,
      0,
      d.sha256 || ':v' || d.ingestion_version,
      d.created_at,
      d.created_at
    FROM inserted_document d
    RETURNING id, document_id, status, idempotency_key, created_at
  )
  SELECT
    d.id AS document_id,
    j.id AS ingestion_job_id,
    d.status AS document_status,
    j.status AS job_status,
    d.ingestion_version,
    d.storage_path,
    d.sha256,
    j.idempotency_key,
    d.created_at,
    d.user_id
  FROM inserted_document d
  JOIN inserted_job j ON j.document_id = d.id;
$$;

REVOKE ALL ON FUNCTION public.create_document_with_ingestion_job_for_user(text, text, text, public.supported_language, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_document_with_ingestion_job_for_user(text, text, text, public.supported_language, uuid) TO service_role;
