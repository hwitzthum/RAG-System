import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  if (!authResult.ok) {
    return authResult.response;
  }

  const supabase = getSupabaseAdminClient();

  // Fetch document to get storage path
  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("id", id)
    .single();

  if (fetchError || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Remove storage file + related records in parallel (all independent of each other)
  await Promise.all([
    doc.storage_path ? supabase.storage.from(env.RAG_STORAGE_BUCKET).remove([doc.storage_path]) : Promise.resolve(),
    supabase.from("ingestion_jobs").delete().eq("document_id", id),
    supabase.from("document_chunks").delete().eq("document_id", id),
  ]);

  // Delete document record last (after foreign-key dependents are gone)
  const { error: deleteError } = await supabase.from("documents").delete().eq("id", id);

  if (deleteError) {
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }

  return NextResponse.json({ status: "ok" });
}
