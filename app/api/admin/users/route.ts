import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

export async function GET(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Authenticate first so the rate-limit key can include the verified user ID,
  // preventing IP-only keys from being exhausted by unauthenticated callers.
  const authResult = await requireAuth(request, ["admin"]);

  if (!authResult.ok) {
    logAuditEvent({
      action: "admin.users.list",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "unauthorized" },
    });
    return authResult.response;
  }

  // Rate limit: 60 requests per 15 minutes per authenticated admin user
  const rl = await consumeSharedRateLimit(`admin:users:list:${authResult.user.id}`, 60, 900, { failOpen: false });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const url = request.nextUrl;
  const page = Math.max(parseInt(url.searchParams.get("page") ?? "", 10) || 1, 1);
  const perPage = Math.min(
    Math.max(parseInt(url.searchParams.get("perPage") ?? "", 10) || DEFAULT_PER_PAGE, 1),
    MAX_PER_PAGE,
  );

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw error;
    }

    const users = data.users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      role: (u.app_metadata?.role as string) ?? "pending",
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
    }));

    logAuditEvent({
      action: "admin.users.list",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "success",
      resource: "admin",
      ipAddress,
      metadata: { userCount: users.length, page, perPage },
    });

    return NextResponse.json({ users, page, perPage }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "admin.users.list",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "list_failed", message },
    });
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }
}
