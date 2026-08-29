import { after, NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { runIngestionTrigger } from "@/lib/ingestion/runtime/trigger";
import { flushTracing } from "@/lib/observability/langfuse";
import { getClientIp } from "@/lib/security/request";
import { extractBearerTokenString } from "@/lib/security/token";

export const runtime = "nodejs";
export const maxDuration = 120;

// The instant this run must be finished by. A batch is only started when it is
// projected to land before it, so this sits close to `maxDuration` rather than
// holding back a whole batch's worth of margin for a fixed cut-off. A document
// too large for one invocation checks itself back in and resumes on the next
// cron tick from its last checkpoint, instead of being killed mid-batch and
// burning a retry.
const INGESTION_RUN_MAX_SECONDS = 100;

// Auth: bearer-token only (CRON_SECRET), validated inside runIngestionTrigger.
// CSRF protection is not applicable — this endpoint does not use cookie-based auth.
async function executeRun(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // This cron path runs the same ingestion pipeline as the worker, but in a
  // serverless function that freezes as soon as it responds.
  after(flushTracing);
  const result = await runIngestionTrigger({
    cronSecret: env.CRON_SECRET,
    bearerToken: extractBearerTokenString(request),
    region: process.env.VERCEL_REGION,
    maxRunSeconds: INGESTION_RUN_MAX_SECONDS,
  });

  if (result.statusCode === 500) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        eventType: "ingestion_run_failed",
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
