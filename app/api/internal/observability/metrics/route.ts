import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { getClientIp } from "@/lib/security/request";
import { extractBearerTokenString } from "@/lib/security/token";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 15;

const metricEventSchema = z.object({
  timestamp: z.string().min(1),
  eventType: z.literal("metric"),
  metricName: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().max(32).optional(),
  tags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

function isMetricsSinkAuthorized(request: NextRequest): boolean {
  if (!env.OBSERVABILITY_METRICS_SINK_AUTH_TOKEN) {
    return false;
  }

  const token = extractBearerTokenString(request);
  if (!token) {
    return false;
  }

  const providedDigest = createHash("sha256").update(token, "utf8").digest();
  const expectedDigest = createHash("sha256").update(env.OBSERVABILITY_METRICS_SINK_AUTH_TOKEN, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  if (!isMetricsSinkAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = metricEventSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid metric event payload" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("metric_events").insert({
      metric_name: parsed.data.metricName,
      value: parsed.data.value,
      unit: parsed.data.unit ?? null,
      tags: {
        ...(parsed.data.tags ?? {}),
        ingestedFromIp: ipAddress,
      },
      source: "web",
      created_at: parsed.data.timestamp,
    });

    if (error) {
      throw error;
    }

    return NextResponse.json({ status: "accepted" }, { status: 202 });
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        eventType: "metric_sink_persist_error",
        message: error instanceof Error ? error.message : "unknown_error",
        ipAddress,
      }),
    );

    return NextResponse.json({ error: "Failed to persist metric event" }, { status: 500 });
  }
}
