import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { runIngestionBatch } from "@/lib/ingestion/runtime/runner";
import { resolveIngestionRuntimeSettings } from "@/lib/ingestion/runtime/types";
import { getClientIp } from "@/lib/security/request";
import { extractBearerTokenString } from "@/lib/security/token";

export const runtime = "nodejs";
export const maxDuration = 120;

function isCronAuthorized(request: NextRequest): boolean {
  if (!env.CRON_SECRET) {
    return false;
  }

  const token = extractBearerTokenString(request);
  if (!token) {
    return false;
  }

  const providedDigest = createHash("sha256").update(token, "utf8").digest();
  const expectedDigest = createHash("sha256").update(env.CRON_SECRET, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

async function executeRun(request: NextRequest) {
  const ipAddress = getClientIp(request);

  if (env.INGESTION_RUNTIME_MODE !== "vercel") {
    return NextResponse.json(
      {
        error: "Ingestion runtime mode is not set to vercel",
        mode: env.INGESTION_RUNTIME_MODE,
      },
      { status: 409 },
    );
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json(
      {
        error: "Unauthorized",
      },
      { status: 401 },
    );
  }

  const region = process.env.VERCEL_REGION?.trim() || "unknown";
  const settings = resolveIngestionRuntimeSettings({
    workerName: `vercel-ingestion-runner-${region}`,
  });

  try {
    const metrics = await runIngestionBatch({ settings, logger: console });

    return NextResponse.json(
      {
        status: metrics.claimed === 0 ? "idle" : "processed",
        claimed: metrics.claimed,
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        eventType: "ingestion_run_failed",
        message,
        ipAddress,
      }),
    );

    return NextResponse.json(
      {
        error: "Failed to run ingestion batch",
        message,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return executeRun(request);
}

// Useful for manual trigger workflows while keeping identical auth behavior.
export async function POST(request: NextRequest) {
  return executeRun(request);
}
