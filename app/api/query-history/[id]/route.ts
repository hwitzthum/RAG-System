import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import {
  deleteQueryHistoryEntry,
  createDeleteQueryHistoryClient,
  type DeleteQueryHistorySupabaseClient,
} from "@/lib/query-history/delete-query-history";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ipAddress = getClientIp(request);
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);

  if (!authResult.ok) {
    logAuditEvent({
      action: "query.history.delete",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: `query_history:${id}`,
      ipAddress,
      metadata: { reason: "unauthorized" },
    });
    return authResult.response;
  }

  try {
    const supabase = getSupabaseAdminClient() as unknown as DeleteQueryHistorySupabaseClient;
    const deletedEntry = await deleteQueryHistoryEntry({
      client: createDeleteQueryHistoryClient(supabase),
      entryId: id,
      userId: authResult.user.id,
    });

    if (!deletedEntry) {
      logAuditEvent({
        action: "query.history.delete",
        actorId: authResult.user.id,
        actorRole: authResult.user.role,
        outcome: "failure",
        resource: `query_history:${id}`,
        ipAddress,
        metadata: { reason: "not_found" },
      });
      return NextResponse.json({ error: "Query history entry not found" }, { status: 404 });
    }

    logAuditEvent({
      action: "query.history.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: `query_history:${id}`,
      ipAddress,
      metadata: {
        conversationId: deletedEntry.conversationId,
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    logAuditEvent({
      action: "query.history.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: `query_history:${id}`,
      ipAddress,
      metadata: {
        reason: "delete_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });

    return NextResponse.json({ error: "Failed to delete query history entry" }, { status: 500 });
  }
}
