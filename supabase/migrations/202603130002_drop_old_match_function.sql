-- Drop the old match_document_chunks overload that still uses vector(1536).
-- The 202603130001 migration created a new 4-param version with vector(1024)
-- but did not drop the older 3-param version with vector(1536), causing
-- ambiguous function resolution errors.

-- Drop old 3-param signature (from 202603060003)
DROP FUNCTION IF EXISTS public.match_document_chunks(vector(1536), integer, public.supported_language);

-- Drop old 4-param signature if it somehow has 1536 dims (from 202603110001)
DROP FUNCTION IF EXISTS public.match_document_chunks(vector(1536), integer, public.supported_language, uuid[]);
