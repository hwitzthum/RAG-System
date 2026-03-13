import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { normalizeLanguageHint } from "@/lib/ingestion/upload-helpers";
import { queueSingleUpload } from "@/lib/ingestion/upload-queue";
import { env } from "@/lib/config/env";
import { persistUploadAndQueueJob } from "@/lib/ingestion/upload-service";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";
export const maxDuration = 120;

const uploadMetadataSchema = z.object({
  title: z.string().trim().max(240).optional(),
  languageHint: z.enum(["EN", "DE", "FR", "IT", "ES"]).nullable(),
});

export async function POST(request: NextRequest) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    logAuditEvent({
      action: "upload.create",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "upload",
      ipAddress,
      metadata: { reason: "unauthorized" },
    });

    return authResult.response;
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    logAuditEvent({
      action: "upload.create",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "upload",
      ipAddress,
      metadata: { reason: "invalid_form_data" },
    });

    return NextResponse.json({ error: "Invalid upload payload" }, { status: 400 });
  }

  const file = formData.get("file");
  const titleRaw = formData.get("title");
  const languageRaw = formData.get("language_hint");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }

  if (file.size > env.RAG_MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds maximum upload size of ${env.RAG_MAX_UPLOAD_BYTES} bytes`,
      },
      { status: 413 },
    );
  }

  // Validate PDF magic bytes (%PDF-)
  const headerBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const isValidPdfSignature = headerBytes.length >= 5 && headerBytes.every((b, i) => b === pdfMagic[i]);
  if (!isValidPdfSignature) {
    logAuditEvent({
      action: "upload.create",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "upload",
      ipAddress,
      metadata: { reason: "invalid_pdf_signature", fileName: file.name },
    });
    return NextResponse.json({ error: "File does not have a valid PDF signature" }, { status: 400 });
  }

  const rawLanguageHint = typeof languageRaw === "string" ? languageRaw : null;
  const languageHint = normalizeLanguageHint(rawLanguageHint);
  if (rawLanguageHint && !languageHint) {
    return NextResponse.json({ error: "Invalid language_hint value" }, { status: 400 });
  }
  const parsedMetadata = uploadMetadataSchema.safeParse({
    title: typeof titleRaw === "string" ? titleRaw : undefined,
    languageHint,
  });

  if (!parsedMetadata.success) {
    return NextResponse.json({ error: "Invalid upload metadata" }, { status: 400 });
  }

  try {
    const queued = await queueSingleUpload({
      file,
      ipAddress,
      title: parsedMetadata.data.title ?? null,
      languageHint: parsedMetadata.data.languageHint,
      user: authResult.user,
      dependencies: {
        persistUploadAndQueueJob,
        logAuditEvent,
      },
    });

    return NextResponse.json(queued.body, { status: queued.statusCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";

    logAuditEvent({
      action: "upload.create",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "upload",
      ipAddress,
      metadata: {
        reason: "persistence_failed",
        message,
      },
    });

    return NextResponse.json({ error: "Failed to persist upload" }, { status: 500 });
  }
}
