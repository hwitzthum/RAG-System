import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { createDeleteDocumentClient, deleteDocumentCascade } from "@/lib/documents/delete-document";
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
  let deletedDocument;

  try {
    deletedDocument = await deleteDocumentCascade({
      client: createDeleteDocumentClient(supabase),
      documentId: id,
    });
  } catch (error) {
    logAuditEvent({
      action: "document.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `document:${id}`,
      ipAddress,
      metadata: {
        reason: "delete_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }

  if (!deletedDocument) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const storageResult = deletedDocument.storagePath
    ? await supabase.storage.from(env.RAG_STORAGE_BUCKET).remove([deletedDocument.storagePath])
    : { error: null };

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

  logAuditEvent({
    action: "document.delete",
    actorId: authResult.user.id,
    actorRole: authResult.user.role,
    outcome: "success",
    resource: `document:${id}`,
    ipAddress,
    metadata: {
      deletedJobCount: deletedDocument.deletedJobCount,
      deletedChunkCount: deletedDocument.deletedChunkCount,
    },
  });

  return NextResponse.json({ status: "ok" });
}
