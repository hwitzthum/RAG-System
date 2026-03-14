import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthUser } from "@/lib/auth/types";
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

type AccessibleDocumentIdRow = Pick<Database["public"]["Tables"]["documents"]["Row"], "id">;

export async function listEffectiveDocuments(
  supabase: SupabaseClient<Database>,
  input: { limit: number; offset: number; user: AuthUser },
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
  const accessibleDocumentIds = await listAccessibleDocumentIds(supabase, { user: input.user });
  if (input.user.role !== "admin" && accessibleDocumentIds.length === 0) {
    return { documents: [], total: 0 };
  }

  let query = supabase
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
    .order("created_at", { ascending: false });

  if (input.user.role !== "admin") {
    query = query.in("document_id", accessibleDocumentIds);
  }

  const { data, error, count } = await query.range(input.offset, input.offset + input.limit - 1);

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
  input: { user: AuthUser; documentId: string },
): Promise<EffectiveDocumentDetailRow | null> {
  if (input.user.role !== "admin") {
    const { data: accessRow, error: accessError } = await supabase
      .from("documents")
      .select("id")
      .eq("id", input.documentId)
      .or(`user_id.eq.${input.user.id},user_id.is.null`)
      .maybeSingle();

    if (accessError) {
      throw new Error(`Failed to verify effective document access for ${input.documentId}: ${accessError.message}`);
    }

    if (!accessRow) {
      return null;
    }
  }

  const query = supabase
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
    .eq("document_id", input.documentId);

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch effective document ${input.documentId}: ${error.message}`);
  }

  return data as EffectiveDocumentDetailRow | null;
}

export async function listAccessibleDocumentIds(
  supabase: SupabaseClient<Database>,
  input: { user: AuthUser },
): Promise<string[]> {
  if (input.user.role === "admin") {
    return [];
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id")
    .eq("status", "ready")
    .or(`user_id.eq.${input.user.id},user_id.is.null`)
    .returns<AccessibleDocumentIdRow[]>();

  if (error) {
    throw new Error(`Failed to list accessible documents for ${input.user.id}: ${error.message}`);
  }

  return [...new Set((data ?? []).map((row) => row.id))];
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
