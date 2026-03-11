import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ipAddress = getClientIp(request);

  const authResult = await requireAuthWithCsrf(request, ["admin"]);
  if (!authResult.ok) {
    logAuditEvent({
      action: "document.delete",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: `document:${id}`,
      ipAddress,
      metadata: { reason: "unauthorized" },
    });
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
  const [storageResult, jobsResult, chunksResult] = await Promise.all([
    doc.storage_path
      ? supabase.storage.from(env.RAG_STORAGE_BUCKET).remove([doc.storage_path])
      : Promise.resolve({ error: null }),
    supabase.from("ingestion_jobs").delete().eq("document_id", id),
    supabase.from("document_chunks").delete().eq("document_id", id),
  ]);

  // Log partial failures but continue — the document record must still be deleted
  // to avoid leaving a dangling reference that blocks re-upload.
  if (storageResult.error) {
    logAuditEvent({
      action: "document.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `document:${id}:storage`,
      ipAddress,
      metadata: { reason: "storage_delete_failed", message: storageResult.error.message },
    });
  }
  if (jobsResult.error) {
    logAuditEvent({
      action: "document.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `document:${id}:ingestion_jobs`,
      ipAddress,
      metadata: { reason: "jobs_delete_failed", message: jobsResult.error.message },
    });
  }
  if (chunksResult.error) {
    logAuditEvent({
      action: "document.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `document:${id}:chunks`,
      ipAddress,
      metadata: { reason: "chunks_delete_failed", message: chunksResult.error.message },
    });
  }

  // Delete document record last (after foreign-key dependents are gone)
  const { error: deleteError } = await supabase.from("documents").delete().eq("id", id);

  if (deleteError) {
    logAuditEvent({
      action: "document.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `document:${id}`,
      ipAddress,
      metadata: { reason: "delete_failed" },
    });
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }

  logAuditEvent({
    action: "document.delete",
    actorId: authResult.user.id,
    actorRole: authResult.user.role,
    outcome: "success",
    resource: `document:${id}`,
    ipAddress,
  });

  return NextResponse.json({ status: "ok" });
}
