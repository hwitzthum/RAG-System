# Database Bootstrap (Phase 2)

The canonical Phase 2 bootstrap SQL is in:

- `supabase/migrations/202603060001_phase2_bootstrap.sql`

This migration covers:

- enabling `pgvector`
- creating/configuring the private `documents` storage bucket
- creating storage object policies for `admin` and `reader` roles
