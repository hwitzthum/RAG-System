import type { NextRequest } from "next/server";
import { handleAdminRuntimeStatusGet } from "@/lib/admin/runtime-status-route";
import { requireAuth } from "@/lib/auth/request-auth";
import { getAdminRuntimeStatus } from "@/lib/admin/runtime-status";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const ipAddress = getClientIp(request);
  return handleAdminRuntimeStatusGet({
    ipAddress,
    dependencies: {
      consumeRateLimit: (key, limit, windowSeconds) => consumeSharedRateLimit(key, limit, windowSeconds),
      requireAdminAuth: () => requireAuth(request, ["admin"]),
      getRuntimeStatus: () => getAdminRuntimeStatus(getSupabaseAdminClient()),
      logAuditEvent,
    },
  });
}
