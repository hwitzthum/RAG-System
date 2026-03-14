import { after } from "next/server";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { hasPdfSignature, looksLikePdfUpload } from "@/lib/ingestion/upload-helpers";
import { queueBatchUploadEntry } from "@/lib/ingestion/upload-queue";
import { scheduleIngestionAutoKick } from "@/lib/ingestion/runtime/auto-kick";
import { persistUploadAndQueueJob } from "@/lib/ingestion/upload-service";
import { logAuditEvent } from "@/lib/observability/audit";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";
export const maxDuration = 120;

type BatchResult = {
  fileName: string;
  documentId?: string;
  status: "accepted" | "rejected";
  error?: string;
};

export async function POST(request: NextRequest) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    logAuditEvent({
      action: "upload.batch",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "upload",
      ipAddress,
      metadata: { reason: "unauthorized" },
    });
    return authResult.response;
  }

  // Rate limit: 10 batch uploads per 15 minutes per user
  const rl = await consumeSharedRateLimit(`upload:batch:${authResult.user.id}`, 10, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many batch upload requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload payload" }, { status: 400 });
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  if (files.length > env.RAG_MAX_BATCH_UPLOAD_COUNT) {
    return NextResponse.json(
      { error: `Maximum ${env.RAG_MAX_BATCH_UPLOAD_COUNT} files per batch` },
      { status: 400 },
    );
  }

  const results: BatchResult[] = [];

  for (const file of files) {
    if (!looksLikePdfUpload(file.name, file.type)) {
      results.push({ fileName: file.name, status: "rejected", error: "Not a PDF file" });
      continue;
    }

    if (file.size === 0) {
      results.push({ fileName: file.name, status: "rejected", error: "Empty file" });
      continue;
    }

    if (file.size > env.RAG_MAX_UPLOAD_BYTES) {
      results.push({ fileName: file.name, status: "rejected", error: "File too large" });
      continue;
    }

    const signatureBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (!hasPdfSignature(signatureBytes)) {
      results.push({ fileName: file.name, status: "rejected", error: "Invalid PDF signature" });
      continue;
    }

    try {
      const accepted = await queueBatchUploadEntry({
        file,
        user: authResult.user,
        ipAddress,
        title: file.name,
        languageHint: null,
        dependencies: {
          persistUploadAndQueueJob,
          logAuditEvent,
        },
      });
      results.push(accepted);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      results.push({ fileName: file.name, status: "rejected", error: message });
    }
  }

  logAuditEvent({
    action: "upload.batch",
    actorId: authResult.user.id,
    actorRole: authResult.user.role,
    outcome: "success",
    resource: "upload",
    ipAddress,
    metadata: {
      totalFiles: files.length,
      accepted: results.filter((r) => r.status === "accepted").length,
      rejected: results.filter((r) => r.status === "rejected").length,
    },
  });

  scheduleIngestionAutoKick({
    acceptedCount: results.filter((result) => result.status === "accepted").length,
    cronSecret: env.CRON_SECRET,
    region: process.env.VERCEL_REGION,
    logger: console,
    dependencies: {
      schedule: after,
    },
  });

  return NextResponse.json({ results }, { status: 200 });
}
