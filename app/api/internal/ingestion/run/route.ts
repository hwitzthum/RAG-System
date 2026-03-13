import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { runIngestionTrigger } from "@/lib/ingestion/runtime/trigger";
import { getClientIp } from "@/lib/security/request";
import { extractBearerTokenString } from "@/lib/security/token";

export const runtime = "nodejs";
export const maxDuration = 120;

async function executeRun(request: NextRequest) {
  const ipAddress = getClientIp(request);
  const result = await runIngestionTrigger({
    cronSecret: env.CRON_SECRET,
    bearerToken: extractBearerTokenString(request),
    region: process.env.VERCEL_REGION,
  });

  if (result.statusCode === 500) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        eventType: "ingestion_run_failed",
        message: result.body.message,
        ipAddress,
      }),
    );
  }

  return NextResponse.json(result.body, { status: result.statusCode });
}

export async function GET(request: NextRequest) {
  return executeRun(request);
}

// Useful for manual trigger workflows while keeping identical auth behavior.
export async function POST(request: NextRequest) {
  return executeRun(request);
}
