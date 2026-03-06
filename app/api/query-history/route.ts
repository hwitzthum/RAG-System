import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const queryHistoryParamsSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
  conversationId: z.string().uuid().optional(),
});

type CitationRecord = {
  documentId: string;
  pageNumber: number;
  chunkId: string;
};

function normalizeCitations(value: unknown): CitationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: CitationRecord[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const documentId = typeof record.documentId === "string" ? record.documentId : null;
    const chunkId = typeof record.chunkId === "string" ? record.chunkId : null;
    const pageNumber =
      typeof record.pageNumber === "number"
        ? record.pageNumber
        : typeof record.pageNumber === "string"
          ? Number.parseInt(record.pageNumber, 10)
          : Number.NaN;

    if (!documentId || !chunkId || !Number.isFinite(pageNumber) || pageNumber <= 0) {
      continue;
    }

    result.push({ documentId, chunkId, pageNumber });
  }

  return result;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = queryHistoryParamsSchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query-history parameters" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from("query_history")
    .select("id,conversation_id,query,answer,citations,latency_ms,cache_hit,created_at")
    .eq("user_id", authResult.user.id)
    .order("created_at", { ascending: false })
    .limit(parsed.data.limit);

  if (parsed.data.conversationId) {
    query = query.eq("conversation_id", parsed.data.conversationId);
  }

  const { data, error } = await query;

  if (error) {
    logAuditEvent({
      action: "query.history.read",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query_history",
      ipAddress,
      metadata: {
        reason: "query_history_select_failed",
        message: error.message,
      },
    });

    return NextResponse.json({ error: "Failed to fetch query history" }, { status: 500 });
  }

  logAuditEvent({
    action: "query.history.read",
    actorId: authResult.user.id,
    actorRole: authResult.user.role,
    outcome: "success",
    resource: "query_history",
    ipAddress,
    metadata: {
      limit: parsed.data.limit,
      conversationId: parsed.data.conversationId ?? null,
      count: data?.length ?? 0,
    },
  });

  return NextResponse.json({
    items: (data ?? []).map((item) => ({
      id: item.id,
      conversationId: item.conversation_id,
      query: item.query,
      answer: item.answer,
      citations: normalizeCitations(item.citations),
      latencyMs: item.latency_ms,
      cacheHit: item.cache_hit,
      createdAt: item.created_at,
    })),
  });
}
