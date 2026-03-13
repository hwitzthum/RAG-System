import { readFileSync, writeFileSync } from "fs";
import type { SupabaseClient } from "@supabase/supabase-js";

export const READER_STATE_PATH = "tests/e2e/.auth/reader.json";
export const ADMIN_STATE_PATH = "tests/e2e/.auth/admin.json";
export const READER_TOKEN_PATH = "tests/e2e/.auth/reader.token";
export const ADMIN_TOKEN_PATH = "tests/e2e/.auth/admin.token";

export function saveToken(path: string, token: string): void {
  writeFileSync(path, token, "utf-8");
}

export function loadToken(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

let _adminClient: SupabaseClient | null = null;

/** Shared Supabase admin client for E2E tests (cached singleton). */
export function getTestAdminClient(): SupabaseClient {
  if (_adminClient) return _adminClient;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  _adminClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _adminClient;
}

/** Fetch an access token from Supabase Auth. */
export async function fetchAccessToken(email: string, password: string): Promise<string> {
  const response = await fetch(`${process.env.SUPABASE_URL!}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY! },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}
