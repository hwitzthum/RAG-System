// GET /api/ingest/[documentId] — how far along is this document?
//
// Ingestion is asynchronous: the upload returns as soon as the file is stored,
// and a worker indexes it afterwards. Without this the dashboard could only say
// "sent" and never "ready", which is the difference between a status and a hope.
//
// Reads `document_effective_statuses`, the view the app's own document list
// uses, so the dashboard and the app can never disagree about a document. That
// view is keyed by `document_id` and carries no owner, so ownership is checked
// against `documents` — one narrow query rather than an assumption.

import { NextResponse, type NextRequest } from "next/server";

import { authenticated, configured } from "@/lib/integration/auth";
import {
  serviceUserId,
  ServiceUserError,
} from "@/lib/integration/service-user";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  if (!configured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a dashboard." },
      { status: 503 },
    );
  }

  if (!authenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { documentId } = await params;
  if (!UUID.test(documentId)) {
    return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  }

  let owner: string;
  try {
    owner = await serviceUserId();
  } catch (error) {
    if (error instanceof ServiceUserError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  const supabase = getSupabaseAdminClient();

  /*
   * Scoped to what the dashboard itself put here. The service account is an
   * admin and could read any document's status, but this endpoint exists to
   * follow an upload the dashboard made — answering for other people's
   * documents would be a wider door than the feature needs.
   */
  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id,user_id")
    .eq("id", documentId)
    .maybeSingle<{ id: string; user_id: string | null }>();

  if (documentError) {
    console.error(
      "[integration] document lookup failed",
      documentError.message,
    );
    return NextResponse.json(
      { error: "Failed to read status" },
      { status: 500 },
    );
  }

  if (!document || (document.user_id && document.user_id !== owner)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("document_effective_statuses")
    .select(
      [
        "document_id",
        "title",
        "effective_status",
        "latest_job_status",
        "latest_job_current_stage",
        "latest_job_chunks_processed",
        "latest_job_chunks_total",
        "latest_job_last_error",
        "chunk_count",
        "created_at",
      ].join(","),
    )
    .eq("document_id", documentId)
    .maybeSingle<{
      document_id: string;
      title: string | null;
      effective_status: string;
      latest_job_status: string | null;
      latest_job_current_stage: string | null;
      latest_job_chunks_processed: number | null;
      latest_job_chunks_total: number | null;
      latest_job_last_error: string | null;
      chunk_count: number | null;
      created_at: string;
    }>();

  if (error) {
    console.error("[integration] status lookup failed", error.message);
    return NextResponse.json(
      { error: "Failed to read status" },
      { status: 500 },
    );
  }

  if (!data) {
    // The document row exists but the view has not caught up yet: honest
    // "accepted, nothing to report" rather than a 404 the caller would read as
    // "your upload is gone".
    return NextResponse.json({
      documentId,
      status: "pending",
      indexed: false,
      stage: null,
    });
  }

  return NextResponse.json({
    documentId: data.document_id,
    title: data.title,
    status: data.effective_status,
    jobStatus: data.latest_job_status,
    // What the worker is doing right now, and how far in — the difference
    // between a spinner and a status.
    stage: data.latest_job_current_stage,
    chunksProcessed: data.latest_job_chunks_processed,
    chunksTotal: data.latest_job_chunks_total,
    chunks: data.chunk_count,
    error: data.latest_job_last_error,
    createdAt: data.created_at,
    indexed: data.effective_status === "ready",
  });
}
