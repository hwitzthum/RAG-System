import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { generateDocxReport } from "@/lib/reports/docx-generator";
import { generatePdfReport } from "@/lib/reports/pdf-generator";
import type { ReportChunk, ReportInput } from "@/lib/reports/types";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const reportRequestSchema = z.object({
  queryHistoryId: z.string().uuid(),
  format: z.enum(["docx", "pdf"]),
});

export async function POST(request: NextRequest) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    logAuditEvent({
      action: "report.generate",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "report",
      ipAddress,
      metadata: { reason: "unauthorized" },
    });
    return authResult.response;
  }

  const parsed = reportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report request" }, { status: 400 });
  }

  const { queryHistoryId, format } = parsed.data;
  const supabase = getSupabaseAdminClient();

  // Fetch query history entry.
  const { data: historyRow, error: historyError } = await supabase
    .from("query_history")
    .select("*")
    .eq("id", queryHistoryId)
    .eq("user_id", authResult.user.id)
    .single();

  if (historyError || !historyRow) {
    return NextResponse.json({ error: "Query history entry not found" }, { status: 404 });
  }

  const citations = (historyRow.citations ?? []) as Array<{ documentId: string; pageNumber: number; chunkId: string }>;
  const chunkIds = citations.map((c) => c.chunkId);

  // Fetch chunk content.
  let chunks: ReportChunk[] = [];
  if (chunkIds.length > 0) {
    const { data: chunkRows } = await supabase
      .from("document_chunks")
      .select("id, document_id, page_number, section_title, content")
      .in("id", chunkIds);

    if (chunkRows) {
      chunks = chunkRows.map((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        pageNumber: row.page_number,
        sectionTitle: row.section_title ?? "",
        content: row.content,
      }));
    }
  }

  // Fetch document titles.
  const uniqueDocIds = [...new Set(citations.map((c) => c.documentId))];
  const documentTitles: Record<string, string> = {};

  if (uniqueDocIds.length > 0) {
    const { data: docRows } = await supabase
      .from("documents")
      .select("id, title")
      .in("id", uniqueDocIds);

    if (docRows) {
      for (const row of docRows) {
        documentTitles[row.id] = row.title ?? "Untitled";
      }
    }
  }

  const reportInput: ReportInput = {
    query: historyRow.query,
    answer: historyRow.answer,
    citations,
    chunks,
    documentTitles,
    timestamp: new Date(historyRow.created_at).toISOString(),
    language: "EN",
  };

  try {
    let buffer: Buffer;
    let contentType: string;
    let extension: string;

    if (format === "docx") {
      buffer = await generateDocxReport(reportInput);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      extension = "docx";
    } else {
      buffer = await generatePdfReport(reportInput);
      contentType = "application/pdf";
      extension = "pdf";
    }

    logAuditEvent({
      action: "report.generate",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: "report",
      ipAddress,
      metadata: { queryHistoryId, format },
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="report-${queryHistoryId.slice(0, 8)}.${extension}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "report.generate",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "report",
      ipAddress,
      metadata: { queryHistoryId, format, reason: message },
    });

    return NextResponse.json({ error: "Report generation failed" }, { status: 500 });
  }
}
