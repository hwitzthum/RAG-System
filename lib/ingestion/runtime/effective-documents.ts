import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, DocumentStatus } from "@/lib/supabase/database.types";

export type DocumentEffectiveStatusRow = Database["public"]["Views"]["document_effective_statuses"]["Row"];
export type EffectiveDocumentDetailRow = Pick<
  DocumentEffectiveStatusRow,
  | "document_id"
  | "title"
  | "effective_status"
  | "ingestion_version"
  | "created_at"
  | "updated_at"
  | "latest_job_id"
  | "latest_job_status"
  | "latest_job_attempt"
  | "latest_job_last_error"
  | "latest_job_locked_at"
  | "latest_job_locked_by"
  | "latest_job_current_stage"
  | "latest_job_stage_updated_at"
  | "latest_job_chunks_processed"
  | "latest_job_chunks_total"
  | "latest_job_processing_duration_ms"
  | "latest_job_created_at"
  | "latest_job_updated_at"
>;

export async function listEffectiveDocuments(
  supabase: SupabaseClient<Database>,
  input: { limit: number; offset: number },
): Promise<{
  documents: Array<{
    id: string;
    title: string | null;
    status: string;
    created_at: string;
    latest_job_status: string | null;
    current_stage: string | null;
    stage_updated_at: string | null;
    chunks_processed: number | null;
    chunks_total: number | null;
    processing_duration_ms: number | null;
  }>;
  total: number;
}> {
  const { data, error, count } = await supabase
    .from("document_effective_statuses")
    .select(
      [
        "document_id",
        "title",
        "effective_status",
        "created_at",
        "latest_job_status",
        "latest_job_current_stage",
        "latest_job_stage_updated_at",
        "latest_job_chunks_processed",
        "latest_job_chunks_total",
        "latest_job_processing_duration_ms",
      ].join(","),
      { count: "planned" },
    )
    .order("created_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`Failed to fetch effective documents: ${error.message}`);
  }

  const rows = ((data ?? []) as unknown) as Array<
    Pick<
      DocumentEffectiveStatusRow,
      | "document_id"
      | "title"
      | "effective_status"
      | "created_at"
      | "latest_job_status"
      | "latest_job_current_stage"
      | "latest_job_stage_updated_at"
      | "latest_job_chunks_processed"
      | "latest_job_chunks_total"
      | "latest_job_processing_duration_ms"
    >
  >;

  return {
    documents: rows.map((row) => ({
      id: row.document_id,
      title: row.title,
      status: row.effective_status,
      created_at: row.created_at,
      latest_job_status: row.latest_job_status,
      current_stage: row.latest_job_current_stage,
      stage_updated_at: row.latest_job_stage_updated_at,
      chunks_processed: row.latest_job_chunks_processed,
      chunks_total: row.latest_job_chunks_total,
      processing_duration_ms: row.latest_job_processing_duration_ms,
    })),
    total: count ?? 0,
  };
}

export async function getEffectiveDocumentById(
  supabase: SupabaseClient<Database>,
  documentId: string,
): Promise<EffectiveDocumentDetailRow | null> {
  const { data, error } = await supabase
    .from("document_effective_statuses")
    .select(
      [
        "document_id",
        "title",
        "effective_status",
        "ingestion_version",
        "created_at",
        "updated_at",
        "latest_job_id",
        "latest_job_status",
        "latest_job_attempt",
        "latest_job_last_error",
        "latest_job_locked_at",
        "latest_job_locked_by",
        "latest_job_current_stage",
        "latest_job_stage_updated_at",
        "latest_job_chunks_processed",
        "latest_job_chunks_total",
        "latest_job_processing_duration_ms",
        "latest_job_created_at",
        "latest_job_updated_at",
      ].join(","),
    )
    .eq("document_id", documentId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch effective document ${documentId}: ${error.message}`);
  }

  return data as EffectiveDocumentDetailRow | null;
}

export async function countEffectiveDocumentsByStatus(
  supabase: SupabaseClient<Database>,
  input: {
    status: DocumentStatus;
    updatedSince?: string;
  },
): Promise<number> {
  let query = supabase
    .from("document_effective_statuses")
    .select("document_id", { head: true, count: "exact" })
    .eq("effective_status", input.status);

  if (input.updatedSince) {
    query = query.gte("updated_at", input.updatedSince);
  }

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count effective documents with status ${input.status}: ${error.message}`);
  }

  return count ?? 0;
}
