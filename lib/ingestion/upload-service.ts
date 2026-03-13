import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/config/env";
import { buildStoragePath } from "@/lib/ingestion/upload-helpers";
import { createDocumentWithInitialJob, createUploadCreateClient } from "@/lib/ingestion/upload-create";
import {
  createUploadExistingJobClient,
  ensureDocumentQueuedIngestionJob,
} from "@/lib/ingestion/upload-existing-job";
import { shouldRequeueExistingDocument } from "@/lib/ingestion/upload-state";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, DocumentStatus, IngestionJobStatus, SupportedLanguage } from "@/lib/supabase/database.types";

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

type RequeuedDocumentResult = {
  documentId: string;
  ingestionJobId: string;
  documentStatus: DocumentStatus;
  ingestionJobStatus: IngestionJobStatus;
  storagePath: string;
  checksumSha256: string;
};

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

async function requeueDeadLetterDocument(
  supabase: SupabaseClient<Database>,
  documentRecord: DocumentRecord,
): Promise<RequeuedDocumentResult | null> {
  const { data, error } = await supabase.rpc("requeue_dead_letter_document", {
    target_document_id: documentRecord.id,
  });

  if (!error) {
    const row = data?.[0];
    if (!row) {
      return null;
    }

    return {
      documentId: row.document_id,
      ingestionJobId: row.ingestion_job_id,
      documentStatus: row.document_status,
      ingestionJobStatus: row.job_status,
      storagePath: row.storage_path,
      checksumSha256: row.sha256,
    };
  }

  if (!error.message.includes("Could not find the function")) {
    throw error;
  }

  throw new Error(`Required ingestion RPC requeue_dead_letter_document is unavailable (${error.message})`);
}

async function returnExistingDocumentResult(
  supabase: SupabaseClient<Database>,
  documentRecord: DocumentRecord,
): Promise<UploadPersistenceResult> {
  const latestJob = await getLatestIngestionJob(supabase, documentRecord.id);

  if (shouldRequeueExistingDocument(documentRecord.status, latestJob?.status ?? null)) {
    const requeued = await requeueDeadLetterDocument(supabase, documentRecord);
    if (requeued) {
      return {
        ...requeued,
        status: requeued.ingestionJobStatus,
        deduplicated: false,
      };
    }
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

  const ensuredJob = await ensureDocumentQueuedIngestionJob({
    client: createUploadExistingJobClient(supabase),
    documentId: documentRecord.id,
  });

  if (!ensuredJob) {
    throw new Error(`Required ingestion RPC ensure_document_queued_ingestion_job returned no row for ${documentRecord.id}`);
  }

  return {
    documentId: documentRecord.id,
    ingestionJobId: ensuredJob.ingestionJobId,
    documentStatus: ensuredJob.documentStatus,
    ingestionJobStatus: ensuredJob.ingestionJobStatus,
    status: ensuredJob.ingestionJobStatus,
    deduplicated: !ensuredJob.jobCreated,
    storagePath: ensuredJob.storagePath,
    checksumSha256: ensuredJob.checksumSha256,
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

  try {
    const created = await createDocumentWithInitialJob({
      client: createUploadCreateClient(supabase),
      storagePath,
      checksumSha256,
      title: input.title,
      languageHint: input.languageHint,
    });

    if (!created) {
      const racedDocument = await getDocumentByChecksum(supabase, checksumSha256);
      if (racedDocument) {
        return returnExistingDocumentResult(supabase, racedDocument);
      }

      throw new Error("Atomic upload persistence returned no row and no existing document was found");
    }

    return {
      ...created,
      status: created.ingestionJobStatus,
      deduplicated: false,
    };
  } catch (error) {
    await supabase.storage.from(env.RAG_STORAGE_BUCKET).remove([storagePath]);
    throw error;
  }
}
