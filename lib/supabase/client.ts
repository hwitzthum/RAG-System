import { createBrowserClient } from "@supabase/ssr";

export function getSupabaseBrowserClient() {
  // These two bypass the Zod schema in lib/config/env.ts entirely — it
  // validates SUPABASE_URL/SUPABASE_ANON_KEY, which are different variables.
  // The anon key becomes an `apikey` request header, where a stray newline is
  // an illegal header value. The literal `process.env.NEXT_PUBLIC_*` form is
  // kept so Next can still inline these at build time for the browser bundle;
  // a dynamic lookup would resolve to undefined there.
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    { auth: { persistSession: true } },
  );
}
