import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["admin", "reader"]);
  if (!authResult.ok) return authResult.response;

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, status, created_at, storage_path")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 });

  return NextResponse.json({ documents: data ?? [] });
}
