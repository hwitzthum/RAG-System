import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { getEffectiveDocumentById } from "@/lib/ingestion/runtime/effective-documents";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const paramsSchema = z.object({
  documentId: z.string().uuid(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ documentId: string }> },
) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { documentId } = parsedParams.data;

  let documentRecord;
  try {
    documentRecord = await getEffectiveDocumentById(supabase, documentId);
  } catch {
    logAuditEvent({
      action: "upload.status.read",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "upload_status",
      ipAddress,
      metadata: { documentId, reason: "document_query_failed" },
    });

    return NextResponse.json({ error: "Failed to query document status" }, { status: 500 });
  }

  if (!documentRecord) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  logAuditEvent({
    action: "upload.status.read",
    actorId: authResult.user.id,
    actorRole: authResult.user.role,
    outcome: "success",
    resource: "upload_status",
    ipAddress,
    metadata: {
      documentId,
      documentStatus: documentRecord.effective_status,
      ingestionJobStatus: documentRecord.latest_job_status,
    },
  });

  return NextResponse.json({
    document: {
      id: documentRecord.document_id,
      title: documentRecord.title,
      status: documentRecord.effective_status,
      ingestion_version: documentRecord.ingestion_version,
      created_at: documentRecord.created_at,
      updated_at: documentRecord.updated_at,
    },
    latestIngestionJob: documentRecord.latest_job_id
      ? {
          id: documentRecord.latest_job_id,
          status: documentRecord.latest_job_status,
          attempt: documentRecord.latest_job_attempt,
          last_error: documentRecord.latest_job_last_error,
          locked_at: documentRecord.latest_job_locked_at,
          locked_by: documentRecord.latest_job_locked_by,
          current_stage: documentRecord.latest_job_current_stage,
          stage_updated_at: documentRecord.latest_job_stage_updated_at,
          chunks_processed: documentRecord.latest_job_chunks_processed,
          chunks_total: documentRecord.latest_job_chunks_total,
          processing_duration_ms: documentRecord.latest_job_processing_duration_ms,
          created_at: documentRecord.latest_job_created_at,
          updated_at: documentRecord.latest_job_updated_at,
        }
      : null,
  });
}
