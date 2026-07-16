import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { listEffectiveDocuments } from "@/lib/ingestion/runtime/effective-documents";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Authenticate before rate-limiting so the bucket is keyed on the
  // authenticated user rather than a client-controlled IP address.
  // Keying on IP alone lets an unauthenticated flood burn legitimate
  // users' quota and (on non-Vercel deployments) lets attackers rotate
  // synthetic x-forwarded-for values to bypass limits entirely.
  const authResult = await requireAuth(request, ["admin", "reader"]);
  if (!authResult.ok) return authResult.response;

  // Rate limit: 120 requests per 15 minutes per user+IP
  const rl = await consumeSharedRateLimit(`documents:list:${authResult.user.id}:${ipAddress}`, 120, 900, { failOpen: false });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const url = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "", 10) || 0, 0);

  const supabase = getSupabaseAdminClient();
  try {
    const result = await listEffectiveDocuments(supabase, {
      limit,
      offset,
      user: authResult.user,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 });
  }
}
