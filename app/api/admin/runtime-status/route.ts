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
      // Admin-only diagnostic endpoint: fail open on a rate-limiter RPC outage so
      // admins can still check runtime health during the very incident that would
      // be causing the RPC to fail in the first place.
      consumeRateLimit: (key, limit, windowSeconds) =>
        consumeSharedRateLimit(key, limit, windowSeconds, { failOpen: true }),
      requireAdminAuth: () => requireAuth(request, ["admin"]),
      getRuntimeStatus: () => getAdminRuntimeStatus(getSupabaseAdminClient()),
      logAuditEvent,
    },
  });
}
