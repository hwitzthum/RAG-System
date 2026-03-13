#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import {
  applyDocumentReconciliation,
  applyJobReconciliation,
  createReconcileWriteClient,
} from "@/lib/ingestion/runtime/reconcile-write";
import {
  reconcileDocumentStatus,
  reconcileJobState,
  type JobReconciliationSnapshot,
  type ReconciliationSnapshot,
} from "@/lib/ingestion/runtime/reconcile";
import type { Database, DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

type CliArgs = {
  apply: boolean;
  limit: number;
};

type JobRow = Pick<Database["public"]["Tables"]["ingestion_jobs"]["Row"], "document_id" | "status" | "created_at">;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    apply: false,
    limit: 200,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.limit = parsed;
      }
      index += 1;
    }
  }

  return args;
}

async function buildSnapshots(
  supabase: ReturnType<typeof createClient<Database>>,
  limit: number,
): Promise<{
  documentSnapshots: ReconciliationSnapshot[];
  jobSnapshots: JobReconciliationSnapshot[];
}> {
  const { data: documents, error: documentsError } = await supabase
    .from("document_effective_statuses")
    .select("document_id,title,raw_document_status,latest_job_status,chunk_count,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (documentsError) {
    throw new Error(`Failed to load documents: ${documentsError.message}`);
  }

  const typedDocuments = (documents ?? []) as Array<{
    document_id: string;
    title: string | null;
    raw_document_status: DocumentStatus;
    latest_job_status: IngestionJobStatus | null;
    chunk_count: number;
    updated_at: string;
  }>;
  if (typedDocuments.length === 0) {
    return { documentSnapshots: [], jobSnapshots: [] };
  }

  const documentIds = typedDocuments.map((document) => document.document_id);
  const { data: jobs, error: jobsError } = await supabase
    .from("ingestion_jobs")
    .select("id,document_id,status,created_at,locked_at,locked_by")
    .in("document_id", documentIds)
    .order("created_at", { ascending: false });

  if (jobsError) {
    throw new Error(`Failed to load ingestion jobs: ${jobsError.message}`);
  }

  const typedJobs = (jobs ?? []) as Array<JobRow & {
    id: string;
    locked_at: string | null;
    locked_by: string | null;
  }>;

  const documentSnapshots = typedDocuments.map((document) => ({
    documentId: document.document_id,
    title: document.title,
    documentStatus: document.raw_document_status,
    latestJobStatus: document.latest_job_status,
    chunkCount: document.chunk_count,
  }));

  const jobSnapshots: JobReconciliationSnapshot[] = typedJobs.map((job) => ({
    jobId: job.id,
    documentId: job.document_id,
    status: job.status as IngestionJobStatus,
    lockedAt: job.locked_at,
    lockedBy: job.locked_by,
  }));

  return { documentSnapshots, jobSnapshots };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const reconcileWriteClient = createReconcileWriteClient(supabase);

  const { documentSnapshots, jobSnapshots } = await buildSnapshots(supabase, args.limit);
  const documentRepairs = documentSnapshots
    .map((snapshot) => ({
      snapshot,
      decision: reconcileDocumentStatus(snapshot),
    }))
    .filter((entry) => entry.decision);

  const jobRepairs = jobSnapshots
    .map((snapshot) => ({
      snapshot,
      decision: reconcileJobState(snapshot),
    }))
    .filter((entry) => entry.decision);

  if (!args.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          scannedDocuments: documentSnapshots.length,
          scannedJobs: jobSnapshots.length,
          documentRepairs: documentRepairs.map((entry) => ({
            documentId: entry.snapshot.documentId,
            title: entry.snapshot.title,
            currentStatus: entry.snapshot.documentStatus,
            latestJobStatus: entry.snapshot.latestJobStatus,
            chunkCount: entry.snapshot.chunkCount,
            targetStatus: entry.decision?.targetStatus,
            reason: entry.decision?.reason,
          })),
          jobRepairs: jobRepairs.map((entry) => ({
            jobId: entry.snapshot.jobId,
            documentId: entry.snapshot.documentId,
            currentStatus: entry.snapshot.status,
            targetStatus: entry.decision?.targetStatus,
            clearLock: entry.decision?.clearLock,
            reason: entry.decision?.reason,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  let updatedDocuments = 0;
  for (const entry of documentRepairs) {
    const decision = entry.decision;
    if (!decision) {
      continue;
    }

    const applied = await applyDocumentReconciliation(reconcileWriteClient, decision);
    if (applied) {
      updatedDocuments += 1;
    }
  }

  let updatedJobs = 0;
  for (const entry of jobRepairs) {
    const decision = entry.decision;
    if (!decision) {
      continue;
    }

    const applied = await applyJobReconciliation(reconcileWriteClient, decision);
    if (applied) {
      updatedJobs += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        scannedDocuments: documentSnapshots.length,
        scannedJobs: jobSnapshots.length,
        updatedDocuments,
        updatedJobs,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
