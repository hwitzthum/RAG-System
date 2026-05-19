import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import {
  deleteQueryHistoryEntry,
  createDeleteQueryHistoryClient,
  type DeleteQueryHistorySupabaseClient,
} from "@/lib/query-history/delete-query-history";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ipAddress = getClientIp(request);

  // Validate the id parameter is a valid UUID before processing
  const uuidValidation = z.string().uuid().safeParse(id);
  if (!uuidValidation.success) {
    return NextResponse.json({ error: "Invalid query history entry ID" }, { status: 400 });
  }

  // Rate limit: 60 deletes per 15 minutes per IP (fail-open: this is a non-critical write)
  const rl = await consumeSharedRateLimit(`query-history:delete:${ipAddress}`, 60, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

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
