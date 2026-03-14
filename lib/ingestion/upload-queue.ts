import type { AuthUser } from "@/lib/auth/types";
import type { UploadPersistenceInput, UploadPersistenceResult } from "@/lib/ingestion/upload-service";

type AuditPayload = {
  action: string;
  actorId: string | null;
  actorRole: string;
  outcome: string;
  resource: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
};

export type QueueUploadDependencies = {
  persistUploadAndQueueJob(input: UploadPersistenceInput): Promise<UploadPersistenceResult>;
  logAuditEvent(input: AuditPayload): void;
};

export async function queueSingleUpload(input: {
  file: File;
  title: string | null;
  languageHint: UploadPersistenceInput["languageHint"];
  user: AuthUser;
  ipAddress: string;
  dependencies: QueueUploadDependencies;
}): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  const persisted = await input.dependencies.persistUploadAndQueueJob({
    file: input.file,
    title: input.title,
    languageHint: input.languageHint,
    userId: input.user.id,
  });

  input.dependencies.logAuditEvent({
    action: "upload.create",
    actorId: input.user.id,
    actorRole: input.user.role,
    outcome: "success",
    resource: "upload",
    ipAddress: input.ipAddress,
    metadata: {
      documentId: persisted.documentId,
      ingestionJobId: persisted.ingestionJobId,
      fileName: input.file.name,
      fileSizeBytes: input.file.size,
      deduplicated: persisted.deduplicated,
      checksumSha256: persisted.checksumSha256,
    },
  });

  return {
    statusCode: persisted.deduplicated ? 200 : 201,
    body: {
      documentId: persisted.documentId,
      ingestionJobId: persisted.ingestionJobId,
      status: persisted.status,
      documentStatus: persisted.documentStatus,
      ingestionJobStatus: persisted.ingestionJobStatus,
      deduplicated: persisted.deduplicated,
      storagePath: persisted.storagePath,
      checksumSha256: persisted.checksumSha256,
    },
  };
}

export async function queueBatchUploadEntry(input: {
  file: File;
  title: string | null;
  languageHint: UploadPersistenceInput["languageHint"];
  user: AuthUser;
  ipAddress: string;
  dependencies: QueueUploadDependencies;
}): Promise<{
  fileName: string;
  documentId: string;
  status: "accepted";
}> {
  const persisted = await input.dependencies.persistUploadAndQueueJob({
    file: input.file,
    title: input.title,
    languageHint: input.languageHint,
    userId: input.user.id,
  });

  input.dependencies.logAuditEvent({
    action: "upload.batch.file",
    actorId: input.user.id,
    actorRole: input.user.role,
    outcome: "success",
    resource: "upload",
    ipAddress: input.ipAddress,
    metadata: {
      documentId: persisted.documentId,
      fileName: input.file.name,
      deduplicated: persisted.deduplicated,
    },
  });

  return {
    fileName: input.file.name,
    documentId: persisted.documentId,
    status: "accepted",
  };
}
