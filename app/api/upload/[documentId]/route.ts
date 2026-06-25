import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { getEffectiveDocumentById } from "@/lib/ingestion/runtime/effective-documents";
import { logAuditEvent } from "@/lib/observability/audit";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
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
  const ipAddress = getClientIp(request);

  // Authenticate before rate-limiting so the bucket is keyed on the
  // authenticated user rather than a client-controlled IP address.
  const authResult = await requireAuth(request, ["reader", "admin"]);

  if (!authResult.ok) {
    return authResult.response;
  }

  // Rate limit: 120 requests per 15 minutes per user+IP
  const rl = await consumeSharedRateLimit(`upload:status:${authResult.user.id}:${ipAddress}`, 120, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { documentId } = parsedParams.data;

  let documentRecord;
  try {
    documentRecord = await getEffectiveDocumentById(supabase, {
      user: authResult.user,
      documentId,
    });
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

  const isAdmin = authResult.user.role === "admin";

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
          // Redact internal details from non-admin users to avoid leaking
          // implementation-sensitive information (e.g., worker hostnames,
          // error stack traces, internal storage paths).
          last_error: isAdmin ? documentRecord.latest_job_last_error : null,
          locked_at: isAdmin ? documentRecord.latest_job_locked_at : null,
          locked_by: isAdmin ? documentRecord.latest_job_locked_by : null,
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
