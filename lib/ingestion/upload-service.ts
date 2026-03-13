import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/config/env";
import { buildIdempotencyKey, buildStoragePath } from "@/lib/ingestion/upload-helpers";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, DocumentStatus, IngestionJobStatus, SupportedLanguage } from "@/lib/supabase/database.types";
import type { IngestionJob } from "@/lib/ingestion/runtime/types";

export type UploadPersistenceInput = {
  file: File;
  title: string | null;
  languageHint: SupportedLanguage | null;
};

export type UploadPersistenceResult = {
  documentId: string;
  ingestionJobId: string;
  documentStatus: DocumentStatus;
  ingestionJobStatus: IngestionJobStatus;
  status: IngestionJobStatus;
  deduplicated: boolean;
  storagePath: string;
  checksumSha256: string;
};

type DocumentRecord = {
  id: string;
  status: DocumentStatus;
  ingestion_version: number;
  storage_path: string;
  sha256: string;
};

type IngestionJobRecord = {
  id: string;
  status: IngestionJobStatus;
};

function isTerminalFailedStatus(documentStatus: DocumentStatus, latestJobStatus: IngestionJobStatus | null): boolean {
  return (
    documentStatus === "failed" ||
    latestJobStatus === "failed" ||
    latestJobStatus === "dead_letter"
  );
}

function isSupabaseUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: string };
  return candidate.code === "23505";
}

function isStorageAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { statusCode?: string | number; message?: string };
  const statusCode = String(candidate.statusCode ?? "");
  const message = String(candidate.message ?? "").toLowerCase();

  return statusCode === "409" || message.includes("already exists") || message.includes("duplicate");
}

async function getDocumentByChecksum(
  supabase: SupabaseClient<Database>,
  checksumSha256: string,
): Promise<DocumentRecord | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("id,status,ingestion_version,storage_path,sha256")
    .eq("sha256", checksumSha256)
    .maybeSingle<DocumentRecord>();

  if (error) {
    throw error;
  }

  return data;
}

async function getLatestIngestionJob(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<IngestionJobRecord | null> {
  const { data, error } = await supabase
    .from("ingestion_jobs")
    .select("id,status")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<IngestionJobRecord>();

  if (error) {
    throw error;
  }

  return data;
}

async function uploadFileToStorage(
  supabase: SupabaseClient<Database>,
  storagePath: string,
  bytes: Buffer,
): Promise<void> {
  const { error } = await supabase.storage.from(env.RAG_STORAGE_BUCKET).upload(storagePath, bytes, {
    contentType: "application/pdf",
    cacheControl: "3600",
    upsert: false,
  });

  if (error && !isStorageAlreadyExists(error)) {
    throw error;
  }
}

async function createIngestionJob(
  supabase: SupabaseClient<Database>,
  documentId: string,
  idempotencyKey: string,
): Promise<IngestionJobRecord> {
  const { data, error } = await supabase
    .from("ingestion_jobs")
    .insert({
      document_id: documentId,
      status: "queued",
      attempt: 0,
      idempotency_key: idempotencyKey,
    })
    .select("id,status")
    .single<IngestionJobRecord>();

  if (error) {
    throw error;
  }

  return data;
}

async function returnExistingDocumentResult(
  supabase: SupabaseClient<Database>,
  documentRecord: DocumentRecord,
): Promise<UploadPersistenceResult> {
  const latestJob = await getLatestIngestionJob(supabase, documentRecord.id);

  if (isTerminalFailedStatus(documentRecord.status, latestJob?.status ?? null)) {
    const { data: requeuedDocument, error: requeueError } = await supabase
      .from("documents")
      .update({
        status: "queued",
        ingestion_version: documentRecord.ingestion_version + 1,
      })
      .eq("id", documentRecord.id)
      .select("id,status,ingestion_version,storage_path,sha256")
      .single<DocumentRecord>();

    if (requeueError) {
      throw requeueError;
    }

    const idempotencyKey = buildIdempotencyKey(requeuedDocument.sha256, requeuedDocument.ingestion_version);
    let requeuedJob: IngestionJobRecord;
    try {
      requeuedJob = await createIngestionJob(supabase, requeuedDocument.id, idempotencyKey);
    } catch (error) {
      if (!isSupabaseUniqueViolation(error)) {
        throw error;
      }
      const racedJob = await getLatestIngestionJob(supabase, requeuedDocument.id);
      if (!racedJob) {
        throw error;
      }
      requeuedJob = racedJob;
    }

    return {
      documentId: requeuedDocument.id,
      ingestionJobId: requeuedJob.id,
      documentStatus: requeuedDocument.status,
      ingestionJobStatus: requeuedJob.status,
      status: requeuedJob.status,
      deduplicated: false,
      storagePath: requeuedDocument.storage_path,
      checksumSha256: requeuedDocument.sha256,
    };
  }

  if (latestJob) {
    return {
      documentId: documentRecord.id,
      ingestionJobId: latestJob.id,
      documentStatus: documentRecord.status,
      ingestionJobStatus: latestJob.status,
      status: latestJob.status,
      deduplicated: true,
      storagePath: documentRecord.storage_path,
      checksumSha256: documentRecord.sha256,
    };
  }

  const idempotencyKey = buildIdempotencyKey(documentRecord.sha256, documentRecord.ingestion_version);
  const createdJob = await createIngestionJob(supabase, documentRecord.id, idempotencyKey);

  return {
    documentId: documentRecord.id,
    ingestionJobId: createdJob.id,
    documentStatus: documentRecord.status,
    ingestionJobStatus: createdJob.status,
    status: createdJob.status,
    deduplicated: false,
    storagePath: documentRecord.storage_path,
    checksumSha256: documentRecord.sha256,
  };
}

export async function persistUploadAndQueueJob(input: UploadPersistenceInput): Promise<UploadPersistenceResult> {
  const supabase = getSupabaseAdminClient();
  const fileBytes = Buffer.from(await input.file.arrayBuffer());
  const checksumSha256 = createHash("sha256").update(fileBytes).digest("hex");
  const storagePath = buildStoragePath(checksumSha256, input.file.name);

  const existingDocument = await getDocumentByChecksum(supabase, checksumSha256);
  if (existingDocument) {
    return returnExistingDocumentResult(supabase, existingDocument);
  }

  await uploadFileToStorage(supabase, storagePath, fileBytes);

  const { data: insertedDocument, error: insertDocumentError } = await supabase
    .from("documents")
    .insert({
      storage_path: storagePath,
      sha256: checksumSha256,
      title: input.title,
      language: input.languageHint,
      status: "queued",
      ingestion_version: 1,
    })
    .select("id,status,ingestion_version,storage_path,sha256")
    .single<DocumentRecord>();

  if (insertDocumentError) {
    if (isSupabaseUniqueViolation(insertDocumentError)) {
      const racedDocument = await getDocumentByChecksum(supabase, checksumSha256);
      if (racedDocument) {
        return returnExistingDocumentResult(supabase, racedDocument);
      }
    }

    await supabase.storage.from(env.RAG_STORAGE_BUCKET).remove([storagePath]);
    throw insertDocumentError;
  }

  const idempotencyKey = buildIdempotencyKey(checksumSha256, insertedDocument.ingestion_version);

  try {
    const createdJob = await createIngestionJob(supabase, insertedDocument.id, idempotencyKey);

    return {
      documentId: insertedDocument.id,
      ingestionJobId: createdJob.id,
      documentStatus: insertedDocument.status,
      ingestionJobStatus: createdJob.status,
      status: createdJob.status,
      deduplicated: false,
      storagePath,
      checksumSha256,
    };
  } catch (error) {
    if (isSupabaseUniqueViolation(error)) {
      const latestJob = await getLatestIngestionJob(supabase, insertedDocument.id);
      if (latestJob) {
        return {
          documentId: insertedDocument.id,
          ingestionJobId: latestJob.id,
          documentStatus: insertedDocument.status,
          ingestionJobStatus: latestJob.status,
          status: latestJob.status,
          deduplicated: true,
          storagePath,
          checksumSha256,
        };
      }
    }

    throw error;
  }
}

export async function processIngestionJobInline(
  documentId: string,
  ingestionJobId: string,
): Promise<{ success: boolean; error?: string }> {
  const [
    { resolveIngestionRuntimeSettings },
    { SupabaseIngestionRuntimeRepository },
    { IngestionPipeline },
  ] = await Promise.all([
    import("@/lib/ingestion/runtime/types"),
    import("@/lib/ingestion/runtime/repository"),
    import("@/lib/ingestion/runtime/pipeline"),
  ]);

  const settings = resolveIngestionRuntimeSettings({
    workerName: "inline-upload-processor",
  });
  const repository = new SupabaseIngestionRuntimeRepository({ settings, logger: console });
  const pipeline = new IngestionPipeline({ settings, repository, logger: console });

  const job: IngestionJob = {
    id: ingestionJobId,
    documentId,
    status: "queued",
    attempt: 0,
  };

  try {
    await pipeline.processJob(job);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    await repository.setDocumentStatus(documentId, "failed").catch(() => null);
    await repository.markJobFailed(job, message).catch(() => null);
    return { success: false, error: message };
  }
}
