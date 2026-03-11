import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
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

  const { data: documentRecord, error: documentError } = await supabase
    .from("documents")
    .select("id,title,status,ingestion_version,created_at,updated_at")
    .eq("id", documentId)
    .maybeSingle();

  if (documentError) {
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

  const { data: latestJob, error: jobError } = await supabase
    .from("ingestion_jobs")
    .select("id,status,attempt,last_error,locked_at,locked_by,created_at,updated_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (jobError) {
    logAuditEvent({
      action: "upload.status.read",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "upload_status",
      ipAddress,
      metadata: { documentId, reason: "job_query_failed" },
    });

    return NextResponse.json({ error: "Failed to query ingestion job status" }, { status: 500 });
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
      documentStatus: documentRecord.status,
      ingestionJobStatus: latestJob?.status ?? null,
    },
  });

  return NextResponse.json({
    document: documentRecord,
    latestIngestionJob: latestJob,
  });
}
