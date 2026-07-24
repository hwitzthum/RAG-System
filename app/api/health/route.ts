import { NextResponse, type NextRequest } from "next/server";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  const ipAddress = getClientIp(request);
  // Unauthenticated monitoring endpoint: fail open on a rate-limiter RPC outage so
  // uptime checks aren't themselves masked by a hard 429 during a Supabase incident.
  const rate = await consumeSharedRateLimit(`health:${ipAddress}`, 60, 60, { failOpen: true });

  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  return NextResponse.json({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  });
}
