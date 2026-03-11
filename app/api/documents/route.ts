import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["admin", "reader"]);
  if (!authResult.ok) return authResult.response;

  const url = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "", 10) || 0, 0);

  const supabase = getSupabaseAdminClient();
  const { data, error, count } = await supabase
    .from("documents")
    .select("id, title, status, created_at", { count: "planned" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 });

  return NextResponse.json({ documents: data ?? [], total: count ?? 0 });
}
