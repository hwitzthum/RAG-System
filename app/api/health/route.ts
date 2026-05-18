import { NextResponse, type NextRequest } from "next/server";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  const ipAddress = getClientIp(request);
  const rate = await consumeSharedRateLimit(`health:${ipAddress}`, 60, 60);

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
