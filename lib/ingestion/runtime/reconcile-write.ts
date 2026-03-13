import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobReconciliationDecision, ReconciliationDecision } from "@/lib/ingestion/runtime/reconcile";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseError = {
  message: string;
};

type ReconcileDocumentRow = Database["public"]["Functions"]["reconcile_document_status"]["Returns"][number];
type ReconcileJobRow = Database["public"]["Functions"]["reconcile_ingestion_job_state"]["Returns"][number];

export type ReconcileWriteClient = {
  runReconcileDocumentStatusRpc(
    args: Database["public"]["Functions"]["reconcile_document_status"]["Args"],
  ): Promise<{ data: ReconcileDocumentRow[] | null; error: SupabaseError | null }>;
  runReconcileIngestionJobStateRpc(
    args: Database["public"]["Functions"]["reconcile_ingestion_job_state"]["Args"],
  ): Promise<{ data: ReconcileJobRow[] | null; error: SupabaseError | null }>;
};

function isMissingRpcFunction(errorMessage: string): boolean {
  return errorMessage.includes("Could not find the function");
}

function buildMissingRpcError(functionName: string, details?: string): Error {
  const suffix = details ? ` (${details})` : "";
  return new Error(`Required reconciliation RPC ${functionName} is unavailable${suffix}`);
}

export function createReconcileWriteClient(supabase: SupabaseClient<Database>): ReconcileWriteClient {
  return {
    async runReconcileDocumentStatusRpc(args) {
      const { data, error } = await supabase.rpc("reconcile_document_status", args);
      return { data, error };
    },
    async runReconcileIngestionJobStateRpc(args) {
      const { data, error } = await supabase.rpc("reconcile_ingestion_job_state", args);
      return { data, error };
    },
  };
}

export async function applyDocumentReconciliation(
  client: ReconcileWriteClient,
  decision: ReconciliationDecision,
): Promise<boolean> {
  const { data, error } = await client.runReconcileDocumentStatusRpc({
    target_document_id: decision.documentId,
    expected_current_status: decision.currentStatus,
    target_status: decision.targetStatus,
  });

  if (!error) {
    return Boolean(data?.[0]);
  }

  if (isMissingRpcFunction(error.message)) {
    throw buildMissingRpcError("reconcile_document_status", error.message);
  }

  throw new Error(`Failed to reconcile document via RPC: ${error.message}`);
}

export async function applyJobReconciliation(
  client: ReconcileWriteClient,
  decision: JobReconciliationDecision,
): Promise<boolean> {
  const shouldRequeueDocument = decision.currentStatus === "processing" && decision.targetStatus === "queued";
  const { data, error } = await client.runReconcileIngestionJobStateRpc({
    target_job_id: decision.jobId,
    expected_current_status: decision.currentStatus,
    target_job_status: decision.targetStatus,
    clear_lock: decision.clearLock,
    target_document_status: shouldRequeueDocument ? "queued" : null,
    expected_document_current_status: shouldRequeueDocument ? "processing" : null,
  });

  if (!error) {
    return Boolean(data?.[0]);
  }

  if (isMissingRpcFunction(error.message)) {
    throw buildMissingRpcError("reconcile_ingestion_job_state", error.message);
  }

  throw new Error(`Failed to reconcile ingestion job via RPC: ${error.message}`);
}
